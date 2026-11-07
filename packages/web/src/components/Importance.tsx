import React, { useMemo, useState } from "react";
import { aiClient } from "@mail/shared/src/store/aiBridge";
import { scopedAccount } from "@mail/shared/src/store/mailStore";
import {
  DEFAULT_IMPORTANCE_POLICY,
  MAX_IMPORTANCE_POLICY,
  importancePolicy,
  type ImportancePrefs,
} from "@mail/shared/src/lib/importance";
import { useMailStore, useTracked } from "../store/mailStore";
import { clientPref, inboxPartCounts } from "../store/selectors";
import type { Thread } from "../store/types";
import { participantsLine } from "../lib/format";
import "../design/topics.css";
import "../design/filters.css";
import "../design/importance.css";

/** The inbox's two lists, with how much sits in each. Stands in for the
 *  list title, so which list you are on is the first thing on screen. */
export function ImportanceSwitch({ view }: { view: "inbox" | "other" }): React.ReactElement {
  const s = useTracked([(s) => s.threads, (s) => s.accountScope]);
  const counts = useMemo(() => inboxPartCounts(s.threads, s.accountScope), [s.threads, s.accountScope]);
  const go = (v: "inbox" | "other") => useMailStore.getState().setView(v);
  return (
    <span className="topic-segments list-parts" role="group" aria-label="Inbox list">
      <button aria-pressed={view === "inbox"} onClick={() => go("inbox")} title="What your policy calls important (i switches)">
        Important <span className="list-part-count">{counts.important.unread || ""}</span>
      </button>
      <button aria-pressed={view === "other"} onClick={() => go("other")} title="Everything else in the inbox (i switches)">
        Other <span className="list-part-count">{counts.other.unread || ""}</span>
      </button>
    </span>
  );
}

/** A thread's verdict and the reason for it; a click moves it to the
 *  other list. Shows only for inbox mail the model or the person judged. */
export function ImportanceChip({ thread }: { thread: Thread }): React.ReactElement | null {
  if (thread.important === undefined || !thread.label_ids.includes("INBOX")) return null;
  const important = thread.important;
  return (
    <span className="thread-importance">
      <button
        className="row-chip thread-importance-chip"
        data-important={important || undefined}
        tabIndex={-1}
        onClick={() => useMailStore.getState().markImportant(!important, [thread._id])}
        title={important ? "Move to Other (-)" : "Move to Important (+)"}
      >
        {important ? "Important" : "Other"}
      </button>
      <span className="thread-importance-why">
        {thread.important_by === "user" ? "marked by you" : thread.important_why}
      </span>
    </span>
  );
}

type Verdict = { thread_gmail_id: string; important: boolean; why: string };

/** The policy in the person's words, a dry run of an edit over the recent
 *  inbox, and the save that re-judges it. */
export function ImportanceSettings(): React.ReactElement {
  const s = useTracked([(s) => s.clientState, (s) => s.threads, (s) => s.accounts, (s) => s.accountScope]);
  const saved = importancePolicy(clientPref<ImportancePrefs>(s, "importance"));
  const [draft, setDraft] = useState(saved);
  const [preview, setPreview] = useState<{ policy: string; verdicts: Verdict[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const account = scopedAccount(s);
  const edited = draft.trim() !== saved.trim();
  const marks = useMemo(() => Object.values(s.threads).filter((t) => t.important_by === "user" && !t.deleted).length, [s.threads]);

  const byGmail = useMemo(() => {
    const m = new Map<string, Thread>();
    for (const t of Object.values(s.threads)) if (t.account_id === account?._id) m.set(t.gmail_id, t);
    return m;
  }, [s.threads, account?._id]);

  const runPreview = async () => {
    setBusy(true);
    setError("");
    try {
      const verdicts = await aiClient().previewImportance({ policy: draft, accountId: account?._id });
      setPreview({ policy: draft, verdicts });
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/\[CONVEX[^\n]*\n?/, "").replace(/^Uncaught Error: /, "") : "Preview failed");
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    useMailStore.getState().setImportancePolicy({ policy: draft });
    useMailStore.getState().pushToast("Saved. Whisk is re-sorting your recent inbox.");
    setPreview(undefined);
  };

  // What the draft would change: threads whose current verdict differs. A
  // hand mark stays where the person put it, so it is never a change.
  const changes = preview && preview.policy === draft
    ? preview.verdicts
        .map((v) => ({ v, t: byGmail.get(v.thread_gmail_id) }))
        .filter(({ v, t }) => t && t.important_by !== "user" && (t.important !== false) !== v.important)
    : null;
  const toImportant = changes?.filter((c) => c.v.important) ?? [];
  const toOther = changes?.filter((c) => !c.v.important) ?? [];
  const shown = preview?.verdicts.filter((v) => v.important).length ?? 0;

  return (
    <section className="settings-section">
      <h3 className="help-group-title">Importance</h3>
      <textarea
        className="importance-policy"
        value={draft}
        maxLength={MAX_IMPORTANCE_POLICY}
        rows={Math.min(16, draft.split("\n").length + 1)}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="What is important to you"
      />
      <div className="settings-row importance-actions">
        <span className="importance-marks">{marks > 0 ? `Learning from ${marks} of your marks` : "Press + or - on a conversation to teach it"}</span>
        {draft.trim() !== DEFAULT_IMPORTANCE_POLICY && (
          <button className="settings-btn is-quiet" onClick={() => setDraft(DEFAULT_IMPORTANCE_POLICY)}>Default</button>
        )}
        <button className="settings-btn" disabled={busy || !draft.trim() || !account} onClick={() => void runPreview()}>
          {busy ? "Reading…" : "Preview"}
        </button>
        <button className="settings-btn is-primary" disabled={!edited || !draft.trim()} onClick={save}>Save</button>
      </div>
      {error && <p className="settings-note is-error">{error}</p>}
      {changes && (
        <div className="importance-preview">
          <div className="importance-preview-sum">
            {preview!.verdicts.length} recent · {shown} important · {changes.length === 0 ? "no changes" : `${changes.length} would move`}
          </div>
          {[["To Important", toImportant], ["To Other", toOther]].map(([title, list]) =>
            (list as typeof toImportant).length > 0 && (
              <div key={title as string} className="importance-preview-group">
                <div className="importance-preview-title">{title as string} · {(list as typeof toImportant).length}</div>
                {(list as typeof toImportant).map(({ v, t }) => (
                  <button
                    key={v.thread_gmail_id}
                    className="filter-match importance-move"
                    onClick={() => { useMailStore.getState().setSettings(false); useMailStore.getState().openThread(t!._id); }}
                  >
                    <span className="filter-match-from">{participantsLine(t!, s.accounts[t!.account_id])}</span>
                    <span className="filter-match-subject">{t!.subject || "(no subject)"}</span>
                    <span className="importance-move-why">{v.why}</span>
                  </button>
                ))}
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}
