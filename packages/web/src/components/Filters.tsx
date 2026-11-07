import React, { useEffect, useRef, useState } from "react";
import { api } from "@mail/convex/convex/_generated/api";
import { aiClient } from "@mail/shared/src/store/aiBridge";
import { convexClient } from "../sync/ConvexSync";
import { useMailStore, useTracked } from "../store/mailStore";
import { scopedAccount } from "@mail/shared/src/store/mailStore";
import type { Filter, FilterAction, Thread } from "../store/types";
import type { Sender } from "@mail/shared/src/lib/sendAs";
import { useRestoreFocus } from "../lib/useRestoreFocus";
import { participantsLine, relativeDate } from "../lib/format";
import { useCoarseNow } from "@mail/platform";
import { KeyCap } from "./KeyCap";
import "../design/topics.css";
import "../design/filters.css";

/** Sentences that show the shape a filter takes: a condition and an action. */
const EXAMPLES = [
  "Star messages from a preschool about admissions that need a reply",
  "Archive receipts under $20 and mark them read",
  "Put anything about the apartment lease in a topic called Lease",
  "Trash marketing from car rental companies",
];

const PREVIEW_LIMIT = 200;

/** How many recent inbox conversations "Run on inbox" reaches. Matches the
 *  server's cap so the button says what it does. */
const RUN_LIMIT = 300;

function actionLabel(a: FilterAction): string {
  switch (a.kind) {
    case "read": return "mark read";
    case "label": return `label ${a.arg}`;
    case "lane": return `file under ${a.arg}`;
    case "cluster": return `topic ${a.arg}`;
    default: return a.kind;
  }
}

export function ActionChips({ actions }: { actions: FilterAction[] }): React.ReactElement {
  return <span className="filter-actions-line">{actions.map((a, i) => <span key={i} className="filter-action-chip" data-kind={a.kind}>{actionLabel(a)}</span>)}</span>;
}

/** One matched conversation: sender and subject, opening the thread when the
 *  local store has it. */
function MatchRow({ thread, subject, me, onOpen }: { thread?: Thread; subject: string; me?: Sender; onOpen: (t: Thread) => void }): React.ReactElement {
  return <button className="filter-match" disabled={!thread} onClick={() => thread && onOpen(thread)} title={thread ? "Open this conversation" : "Not in the local inbox window"}>
    <span className="filter-match-from">{thread ? participantsLine(thread, me) : "—"}</span>
    <span className="filter-match-subject">{thread?.subject || subject || "(no subject)"}</span>
  </button>;
}

export function Filters(): React.ReactElement {
  useRestoreFocus();
  const s = useTracked([s => s.accounts, s => s.filters, s => s.threads, s => s.accountScope]);
  const now = useCoarseNow(30_000);
  const [accountId, setAccount] = useState(scopedAccount(s)?._id ?? "");
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string>();
  const [parsed, setParsed] = useState<{ condition: string; actions: FilterAction[] }>();
  const [matches, setMatches] = useState<string[]>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string>();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const st = useMailStore.getState();
  const close = () => st.setFilters(false);
  const account = s.accounts[accountId];
  const rows = Object.values(s.filters).filter(f => !f.deleted && f.account_id === accountId).sort((a, b) => b.updated_at - a.updated_at);
  const byGmail = new Map<string, Thread>();
  for (const t of Object.values(s.threads)) if (t.account_id === accountId) byGmail.set(t.gmail_id, t);
  const reset = () => { setParsed(undefined); setMatches(undefined); setError(""); };
  useEffect(() => { if (!editing && !text) textRef.current?.focus(); }, [editing, text]);
  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label); setError("");
    try { await work(); } catch (e) { console.error("Filter operation failed", e); setError(e instanceof Error ? e.message.replace(/\[CONVEX[^\n]*\n?/, "").replace(/^Uncaught Error: /, "") : "Filter operation failed"); } finally { setBusy(""); }
  };
  const dispatch = (action: string, args: object) => convexClient().mutation(api.dispatch.dispatch, { token: useMailStore.getState().authToken ?? undefined, action, args: [{ ...args, account_id: accountId }] });
  // One gesture: read the sentence, then show what it would match right now.
  const read = () => text.trim() && run("Reading…", async () => {
    const result = await aiClient().parseFilter({ accountId, text });
    const next = { condition: result.condition, actions: result.actions as FilterAction[] };
    setParsed(next);
    setBusy("Previewing…");
    setMatches(await aiClient().previewFilter({ accountId, condition: next.condition, limit: PREVIEW_LIMIT }));
  });
  const save = (applyNow: boolean) => parsed && run(applyNow ? "Saving and applying…" : "Saving…", async () => {
    await dispatch("saveFilter", { filter_id: editing, text, ...parsed, apply_now: applyNow, thread_gmail_ids: applyNow ? matches ?? [] : undefined });
    setText(""); setEditing(undefined); reset();
    st.pushToast(applyNow ? "Filter saved. Applying to recent inbox mail…" : "Filter saved for new mail");
  });
  const edit = (f: Filter) => { setEditing(f._id); setText(f.text); setParsed({ condition: f.condition, actions: f.actions }); setMatches(undefined); setError(""); setConfirming(undefined); textRef.current?.focus(); };
  const cancelEdit = () => { setText(""); setEditing(undefined); reset(); };
  const open = (t: Thread) => { close(); st.openThread(t._id); };
  const dangerous = (actions: FilterAction[]) => actions.some(a => a.kind === "trash");
  return <div className="overlay" onClick={close}><div className="help filters-panel" role="dialog" aria-modal="true" aria-label="Filters" onClick={e => e.stopPropagation()}>
    <header className="help-head"><h2 className="help-title">Filters</h2><button className="settings-btn" onClick={close}>Close</button></header>
    <p className="settings-note">Say which mail to find and what to do with it, in a sentence. Whisk reads every new message against your condition and acts only on clear matches.</p>
    {Object.keys(s.accounts).length > 1 && <label className="filter-account">Mailbox<select aria-label="Filter mailbox" disabled={!!busy} value={accountId} onChange={e => { setAccount(e.target.value); cancelEdit(); }}>{Object.values(s.accounts).map(a => <option key={a._id} value={a._id}>{a.email}</option>)}</select></label>}
    <div className="filter-compose">
      <label>{editing ? "Edit the sentence" : "New filter"}
        <textarea ref={textRef} aria-label="Filter sentence" placeholder="Star messages about preschool admissions that need a reply" maxLength={2000} disabled={!!busy} value={text}
          onChange={e => { setText(e.target.value); reset(); }}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void read(); } }} />
      </label>
      <div className="filter-compose-actions">
        <button className="settings-btn is-primary" disabled={!text.trim() || !!busy} onClick={() => void read()}>{busy === "Reading…" || busy === "Previewing…" ? busy : "Read and preview"}</button>
        {editing && <button className="settings-btn" disabled={!!busy} onClick={cancelEdit}>Cancel</button>}
        <span className="filter-compose-hint"><KeyCap spec="mod+enter" /> reads · nothing changes until you save</span>
      </div>
      {!text && !editing && <div className="filter-examples" aria-label="Examples">{EXAMPLES.map(ex => <button key={ex} onClick={() => { setText(ex); reset(); textRef.current?.focus(); }}>{ex}</button>)}</div>}
    </div>
    {parsed && <div className="filter-reading">
      <span className="topic-eyebrow">Whisk’s reading</span>
      <p>{parsed.condition}</p>
      <ActionChips actions={parsed.actions} />
      {matches && <div className="filter-matches">
        <p>{matches.length === 0 ? `No matches among the last ${PREVIEW_LIMIT} inbox conversations. Nothing changed.` : `${matches.length} of the last ${PREVIEW_LIMIT} inbox conversations match. Nothing changed yet.`}</p>
        {matches.slice(0, 15).map(id => <MatchRow key={id} thread={byGmail.get(id)} subject={id} me={account ?? undefined} onOpen={open} />)}
        {matches.length > 15 && <p>…and {matches.length - 15} more.</p>}
      </div>}
      <div className="topic-actions">
        <button className="settings-btn is-primary" disabled={!!busy} onClick={() => void save(false)}>{busy === "Saving…" ? busy : editing ? "Save changes" : "Save for new mail"}</button>
        {matches && matches.length > 0 && <button className={`settings-btn${dangerous(parsed.actions) ? " is-danger" : ""}`} disabled={!!busy} onClick={() => void save(true)} title="Save, then run the actions on exactly the conversations listed above">{busy === "Saving and applying…" ? busy : `Save and apply to ${matches.length} now`}</button>}
        <button className="settings-btn is-quiet" disabled={!!busy} onClick={() => textRef.current?.focus()}>Change wording</button>
      </div>
    </div>}
    {error && <p className="topic-error" role="alert">{error}</p>}
    <div className="filter-list">
      {rows.length === 0 && <p className="settings-note">No filters yet for this mailbox.</p>}
      {rows.map(f => <article className={`filter-row${f.enabled ? "" : " is-paused"}`} key={f._id}>
        <div className="filter-row-head">
          <strong>{f.text}</strong>
          <span className="filter-row-meta" data-state={f.enabled ? "on" : "off"}>{f.enabled ? "On" : "Paused"} · {f.hits} {f.hits === 1 ? "match" : "matches"}{f.last_checked_at ? ` · checked ${relativeDate(f.last_checked_at, now)}` : ""}</span>
        </div>
        <p>{f.condition}</p>
        <ActionChips actions={f.actions} />
        {f.last_error && <p className="topic-error is-inline" role="alert">{f.last_error}</p>}
        <div className="topic-actions">
          <button className="settings-btn" disabled={!!busy} onClick={() => edit(f)}>Edit</button>
          <button className="settings-btn" disabled={!!busy} onClick={() => void run(`toggle:${f._id}`, () => dispatch("setFilterEnabled", { filter_id: f._id, enabled: !f.enabled }))}>{busy === `toggle:${f._id}` ? "Updating…" : f.enabled ? "Pause" : "Resume"}</button>
          {confirming === `run:${f._id}`
            ? <span className="topic-confirm"><span>Run the actions on matches among the last {RUN_LIMIT} inbox conversations?</span><button className={`settings-btn ${dangerous(f.actions) ? "is-danger" : "is-primary"}`} disabled={!!busy} onClick={() => { setConfirming(undefined); void run(`run:${f._id}`, async () => { await dispatch("runFilters", { filter_id: f._id }); st.pushToast("Checking recent inbox mail against this filter…"); }); }}>Yes, run</button><button className="settings-btn is-quiet" onClick={() => setConfirming(undefined)}>No</button></span>
            : <button className="settings-btn" disabled={!!busy || !f.enabled} title={f.enabled ? "Judge recent inbox mail against this filter now" : "Resume the filter first"} onClick={() => setConfirming(`run:${f._id}`)}>{busy === `run:${f._id}` ? "Running…" : "Run on inbox"}</button>}
          {confirming === `rm:${f._id}`
            ? <span className="topic-confirm"><span>Delete this filter? Mail it already acted on stays as it is.</span><button className="settings-btn is-danger" disabled={!!busy} onClick={() => { setConfirming(undefined); void run(`rm:${f._id}`, () => dispatch("deleteFilter", { filter_id: f._id })); }}>Delete</button><button className="settings-btn is-quiet" onClick={() => setConfirming(undefined)}>Keep</button></span>
            : <button className="settings-btn is-quiet" disabled={!!busy} onClick={() => setConfirming(`rm:${f._id}`)}>{busy === `rm:${f._id}` ? "Deleting…" : "Delete"}</button>}
        </div>
        {f.recent.length > 0 && <details><summary>Recent matches</summary>{f.recent.map(r => <MatchRow key={r.thread_gmail_id} thread={byGmail.get(r.thread_gmail_id)} subject={r.subject} me={account ?? undefined} onOpen={open} />)}</details>}
      </article>)}
    </div>
  </div></div>;
}
