import React, { useEffect, useMemo, useRef, useState } from "react";
import { aiClient } from "@mail/shared/src/store/aiBridge";
import { scopedAccount } from "@mail/shared/src/store/mailStore";
import {
  DEFAULT_IMPORTANCE_POLICY,
  IMPORTANT,
  MAX_CUTOFF,
  MAX_LENSES,
  MAX_LENS_NAME,
  MAX_LENS_POLICY,
  MIN_CUTOFF,
  inLens,
  lensJudged,
  lensPolicy,
  type Lens,
} from "@mail/shared/src/lib/lenses";
import { useMailStore, useTracked } from "../store/mailStore";
import { inGmailInbox, inScope, inboxLenses, lensView, viewLensId } from "../store/selectors";
import type { Thread, ViewId } from "../store/types";
import { participantsLine } from "../lib/format";
import "../design/topics.css";
import "../design/filters.css";
import "../design/lenses.css";

const st = () => useMailStore.getState();

function SlidersIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <path d="M2 4h7M12 4h2M2 8h2M7 8h7M2 12h9M14 12h0" />
      <circle cx="10.5" cy="4" r="1.5" />
      <circle cx="5.5" cy="8" r="1.5" />
      <circle cx="12.5" cy="12" r="1.5" />
    </svg>
  );
}

/** The inbox's lists as the list's title: Important, each lens, Other,
 *  and the two controls that shape them (tune this one, make another). */
export function LensTabs({ view }: { view: ViewId }): React.ReactElement {
  const s = useTracked([(s) => s.clientState, (s) => s.lensPanel]);
  const lenses = inboxLenses(s);
  const tabs: Array<{ view: ViewId; name: string }> = [...lenses.map((l) => ({ view: lensView(l.id), name: l.name })), { view: "other", name: "Other" }];
  return (
    <span className="lens-tabs" role="tablist" aria-label="Inbox lists">
      {tabs.map((t) => (
        <button
          key={t.view}
          role="tab"
          aria-selected={t.view === view}
          className="lens-tab"
          onClick={() => (t.view === view ? st().setLensPanel(s.lensPanel === "tune" ? null : "tune") : st().setView(t.view))}
        >
          {t.name}
        </button>
      ))}
      <span className="lens-tools">
        <button
          className="lens-tool"
          aria-pressed={s.lensPanel === "tune"}
          onClick={() => st().setLensPanel(s.lensPanel === "tune" ? null : "tune")}
          title={view === "other" ? "Tune Important (Other is what it leaves out)" : "Tune this list"}
        >
          <SlidersIcon />
        </button>
        {lenses.length < MAX_LENSES && (
          <button
            className="lens-tool"
            aria-pressed={s.lensPanel === "new"}
            onClick={() => st().setLensPanel(s.lensPanel === "new" ? null : "new")}
            title="New view: describe what belongs in it"
          >
            +
          </button>
        )}
      </span>
    </span>
  );
}

type Preview = { policy: string; name: string; scores: Map<string, { score: number; why: string }> };

/** Under the tabs: the lens of the list on screen (or a new one) as its
 *  name, its description, and the cutoff that decides how much shows. */
export function LensPanel({ view }: { view: ViewId }): React.ReactElement | null {
  const s = useTracked([(s) => s.lensPanel, (s) => s.clientState, (s) => s.threads, (s) => s.accounts, (s) => s.accountScope]);
  const lenses = inboxLenses(s);
  const creating = s.lensPanel === "new";
  const lens = creating ? undefined : lenses.find((l) => l.id === viewLensId(view));
  if (!s.lensPanel || (!creating && !lens)) return null;
  return <LensEditor key={creating ? "new" : lens!.id} lens={lens} />;
}

function LensEditor({ lens }: { lens?: Lens }): React.ReactElement {
  const s = useTracked([(s) => s.threads, (s) => s.accounts, (s) => s.accountScope, (s) => s.clientState]);
  const creating = !lens;
  const savedPolicy = lens ? lensPolicy(lens) : "";
  const [name, setName] = useState(lens?.name ?? "");
  const [policy, setPolicy] = useState(savedPolicy);
  const [draftCutoff, setDraftCutoff] = useState(50);
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const policyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => (creating ? nameRef.current : null)?.focus(), [creating]);

  const account = scopedAccount(s);
  const cutoff = lens?.cutoff ?? draftCutoff;
  const setCutoff = (c: number) => (lens ? st().setLensCutoff(lens.id, c) : setDraftCutoff(c));
  const edited = creating ? !!policy.trim() : policy.trim() !== savedPolicy.trim() || name.trim() !== lens!.name;
  const previewFresh = preview && preview.policy === policy.trim();

  const inbox = useMemo(() => Object.values(s.threads).filter((t) => inScope(t, s.accountScope) && inGmailInbox(t)), [s.threads, s.accountScope]);
  const byGmail = useMemo(() => new Map(inbox.map((t) => [`${t.account_id}:${t.gmail_id}`, t])), [inbox]);
  const shown = lens ? inbox.filter((t) => inLens(t, lens)).length : 0;
  const judged = lens ? inbox.filter((t) => lensJudged(t, lens.id)).length : 0;
  const marks = lens ? inbox.filter((t) => t.lens_marks?.[lens.id] !== undefined).length : 0;

  const runPreview = async () => {
    setBusy(true);
    setError("");
    try {
      const rows = await aiClient().previewLens({ name: name || lens?.name || "View", policy, accountId: account?._id });
      setPreview({ policy: policy.trim(), name, scores: new Map(rows.map((r) => [`${account?._id}:${r.thread_gmail_id}`, { score: r.score, why: r.why }])) });
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/\[CONVEX[^\n]*\n?/, "").replace(/^Uncaught Error: /, "") : "Preview failed");
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (creating) {
      const id = st().createLens(name.trim() || "View", policy);
      if (id && draftCutoff !== 50) st().setLensCutoff(id, draftCutoff);
      return;
    }
    const isDefault = lens!.id === IMPORTANT && policy.trim() === DEFAULT_IMPORTANCE_POLICY;
    st().saveLens({ id: lens!.id, name: lens!.id === IMPORTANT ? lens!.name : name, policy: isDefault ? undefined : policy });
    st().pushToast(policy.trim() !== savedPolicy.trim() ? `Saved. Whisk is re-sorting ${lens!.name}.` : "Saved");
    setPreview(undefined);
  };

  // What the draft would show at the cutoff, against what shows now. A hand
  // placement stays where the person put it.
  const moves = previewFresh
    ? [...preview!.scores.entries()].flatMap(([key, v]) => {
        const t = byGmail.get(key);
        if (!t) return [];
        const mark = lens ? t.lens_marks?.[lens.id] : undefined;
        const after = mark ?? v.score >= cutoff;
        const before = lens ? inLens(t, lens) : false;
        return after === before ? [] : [{ t, ...v, joins: after }];
      }).sort((a, b) => b.score - a.score)
    : [];
  const previewShown = previewFresh ? [...preview!.scores.values()].filter((v) => v.score >= cutoff).length : 0;
  const joins = moves.filter((m) => m.joins);
  const leaves = moves.filter((m) => !m.joins);

  return (
    <div className="lens-panel">
      <div className="lens-panel-head">
        {lens?.id === IMPORTANT ? (
          <span className="lens-panel-name">Important</span>
        ) : (
          <input
            ref={nameRef}
            className="lens-name"
            value={name}
            maxLength={MAX_LENS_NAME}
            placeholder="Name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && policyRef.current?.focus()}
            aria-label="View name"
          />
        )}
        {lens && (
          <span className="lens-panel-stat">
            {judged < inbox.length && judged < 25 ? "sorting your inbox…" : marks > 0 ? `learning from ${marks} placed by hand` : ""}
          </span>
        )}
        <button className="settings-btn is-quiet lens-done" onClick={() => st().setLensPanel(null)}>Done</button>
      </div>
      <textarea
        ref={policyRef}
        className="importance-policy lens-policy"
        value={policy}
        maxLength={MAX_LENS_POLICY}
        rows={Math.min(12, Math.max(3, policy.split("\n").length + 1))}
        placeholder="What belongs here, in your own words: who it is from, what it is about, what it asks of you"
        onChange={(e) => setPolicy(e.target.value)}
        aria-label="What belongs in this view"
      />
      {(lens || previewFresh) && (
        <div className="lens-cutoff">
          <span className="lens-cutoff-end">Fewer</span>
          <input
            type="range"
            className="lens-slider"
            min={100 - MAX_CUTOFF}
            max={100 - MIN_CUTOFF}
            step={5}
            value={100 - cutoff}
            onChange={(e) => setCutoff(100 - Number(e.target.value))}
            aria-label="How much this view shows"
          />
          <span className="lens-cutoff-end">More</span>
          <span className="lens-cutoff-count">{previewFresh ? `${previewShown} of ${preview!.scores.size} recent` : `${shown} shown`}<span className="lens-cutoff-at"> · {cutoff} and up</span></span>
        </div>
      )}
      <div className="lens-actions">
        {lens && lens.id !== IMPORTANT && (
          <button className="settings-btn is-quiet" onClick={() => st().deleteLens(lens.id)}>Remove view</button>
        )}
        {lens?.id === IMPORTANT && policy.trim() !== DEFAULT_IMPORTANCE_POLICY && (
          <button className="settings-btn is-quiet" onClick={() => setPolicy(DEFAULT_IMPORTANCE_POLICY)}>Default</button>
        )}
        <span className="lens-actions-gap" />
        {error && <span className="lens-error">{error}</span>}
        <button className="settings-btn" disabled={busy || !policy.trim() || !account || !!previewFresh} onClick={() => void runPreview()}>
          {busy ? "Reading…" : "Preview"}
        </button>
        <button className="settings-btn is-primary" disabled={!edited || !policy.trim() || (creating && !name.trim())} onClick={save}>
          {creating ? "Create" : "Save"}
        </button>
      </div>
      {previewFresh && (
        <div className="importance-preview">
          {!creating && <div className="importance-preview-sum">{moves.length === 0 ? "No changes at this cutoff" : `${moves.length} would move at this cutoff`}</div>}
          {[
            [creating ? "Would show" : "Would join", creating ? [...preview!.scores.entries()].flatMap(([key, v]) => (v.score >= cutoff && byGmail.get(key) ? [{ t: byGmail.get(key)!, ...v, joins: true }] : [])).sort((a, b) => b.score - a.score) : joins],
            ["Would leave", leaves],
          ].map(([title, list]) => (list as typeof moves).length > 0 && (
            <div key={title as string} className="importance-preview-group">
              <div className="importance-preview-title">{title as string} · {(list as typeof moves).length}</div>
              {(list as typeof moves).slice(0, 40).map(({ t, score, why }) => (
                <button key={t._id} className="filter-match importance-move" onClick={() => st().openThread(t._id)}>
                  <span className="lens-score">{score}</span>
                  <span className="filter-match-from">{participantsLine(t, s.accounts[t.account_id])}</span>
                  <span className="filter-match-subject">{t.subject || "(no subject)"}</span>
                  <span className="importance-move-why">{why}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** On an open conversation: its place in Important (click to move it) and
 *  the views it sits in (click to open one). */
export function LensChips({ thread }: { thread: Thread }): React.ReactElement | null {
  const s = useTracked([(s) => s.clientState]);
  if (!inGmailInbox(thread)) return null;
  const lenses = inboxLenses(s);
  const important = lenses[0];
  const isImportant = inLens(thread, important);
  const judged = lensJudged(thread, IMPORTANT);
  const others = lenses.slice(1).filter((l) => inLens(thread, l));
  const why = thread.lens_marks?.[IMPORTANT] !== undefined ? "placed by you" : thread.lens_why?.[IMPORTANT];
  return (
    <span className="thread-importance">
      {others.map((l) => (
        <button key={l.id} className="row-chip thread-lens-chip" tabIndex={-1} onClick={() => st().setView(lensView(l.id))} title={thread.lens_why?.[l.id] ?? l.name}>
          {l.name}
        </button>
      ))}
      {judged && (
        <>
          <button
            className="row-chip thread-importance-chip"
            data-important={isImportant || undefined}
            tabIndex={-1}
            onClick={() => st().markInLens(!isImportant, [thread._id], IMPORTANT)}
            title={isImportant ? "Move to Other (-)" : "Move to Important (+)"}
          >
            {isImportant ? "Important" : "Other"}
          </button>
          <span className="thread-importance-why">{why}</span>
        </>
      )}
    </span>
  );
}
