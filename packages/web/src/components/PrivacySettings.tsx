import React, { useMemo, useState } from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import { privacyRules } from "@mail/shared/src/store/selectors";
import { aiAvailable, aiClient } from "@mail/shared/src/store/aiBridge";
import { serverErrorMessage } from "@mail/shared/src/lib/serverError";
import {
  MAX_PRIVACY_RULE,
  MAX_PRIVACY_RULES,
  matchedRules,
  newPrivacyRuleId,
  threadPrivacy,
  type PrivacyRule,
} from "@mail/shared/src/lib/privacy";
import type { Thread } from "../store/types";

// Private mail: the rules, in the person's words, and what they keep from
// agents right now. Rules save like any pref (offline too); the server
// reads mail against a new or reworded rule and the counts move as its
// verdicts arrive on the thread rows. The preview is the one part that
// needs the network, since it asks the model.

type Hit = { account_id: string; thread_gmail_id: string; subject: string; from: string; why: string };

export function PrivacySettings(): React.ReactElement {
  const s = useTracked([(s) => s.threads, (s) => s.clientState, (s) => s.accounts]);
  const rules = privacyRules(s);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [preview, setPreview] = useState<{ text: string; hits: Hit[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showList, setShowList] = useState(false);

  const { hidden, pending, perRule } = useMemo(() => {
    const hidden: Thread[] = [];
    let pending = 0;
    const perRule = new Map<string, number>();
    for (const t of Object.values(s.threads) as Thread[]) {
      // Only the mailboxes connected now; the cache can hold rows of others.
      if (t.deleted || t.message_count === 0 || !s.accounts[t.account_id]) continue;
      const state = threadPrivacy(t, rules);
      if (state === "pending") pending++;
      if (state !== "private") continue;
      hidden.push(t);
      for (const r of matchedRules(t, rules)) perRule.set(r.id, (perRule.get(r.id) ?? 0) + 1);
    }
    hidden.sort((a, b) => b.last_at - a.last_at);
    return { hidden, pending, perRule };
  }, [s.threads, s.accounts, rules]);

  const save = (next: PrivacyRule[]) => useMailStore.getState().savePrivacyRules({ rules: next });
  const text = draft.trim();
  const duplicate = rules.some((r) => r.text.toLowerCase() === text.toLowerCase());
  const canAdd = !!text && !duplicate && rules.length < MAX_PRIVACY_RULES;

  const add = () => {
    if (!canAdd) return;
    save([...rules, { id: newPrivacyRuleId(), text, revision: 1, created_at: Date.now() }]);
    setDraft("");
    setPreview(null);
  };

  const commitEdit = () => {
    if (!editing) return;
    const next = editing.text.trim();
    const rule = rules.find((r) => r.id === editing.id);
    setEditing(null);
    if (!rule || !next || next === rule.text) return;
    save(rules.map((r) => (r.id === rule.id ? { ...r, text: next, revision: r.revision + 1 } : r)));
  };

  const runPreview = async () => {
    setBusy(true);
    setError("");
    try {
      setPreview({ text, hits: await aiClient().previewPrivacy({ text }) });
    } catch (e) {
      setError(serverErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const open = (t: Thread) => {
    const st = useMailStore.getState();
    st.setSettings(false);
    st.openThread(t._id);
  };

  return (
    <section className="settings-section">
      <h3 className="help-group-title">Private mail</h3>

      <div className="pv-summary">
        <button className="pv-count" disabled={hidden.length === 0} onClick={() => setShowList((v) => !v)} aria-expanded={showList}>
          <strong>{hidden.length}</strong> private
        </button>
        {pending > 0 && (
          <span className="pv-count is-pending" title="Hidden from agents until checked against your rules">
            <strong>{pending}</strong> checking
          </span>
        )}
        <span className="pv-who">hidden from agent logins and connected apps</span>
      </div>

      {showList && hidden.length > 0 && (
        <div className="pv-threads">
          {hidden.slice(0, 50).map((t) => (
            <button key={t._id} className="pv-thread" onClick={() => open(t)}>
              <span className="pv-thread-subject">{t.subject || "(no subject)"}</span>
              <span className="pv-thread-why">
                {t.private_mark ? "marked by you" : matchedRules(t, rules).map((r) => `#${rules.indexOf(r) + 1}`).join(" ")}
                {!t.private_mark && t.private_why ? ` · ${t.private_why}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}

      {rules.length > 0 && (
        <ol className="pv-rules">
          {rules.map((r, i) => (
            <li key={r.id} className="pv-rule">
              <span className="pv-rule-n">{i + 1}</span>
              {editing?.id === r.id ? (
                <input
                  className="nt-input"
                  autoFocus
                  maxLength={MAX_PRIVACY_RULE}
                  value={editing.text}
                  onChange={(e) => setEditing({ id: r.id, text: e.target.value })}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitEdit();
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
              ) : (
                <button className="pv-rule-text" title="Reword" onClick={() => setEditing({ id: r.id, text: r.text })}>
                  {r.text}
                </button>
              )}
              <span className="pv-rule-count">{perRule.get(r.id) ?? 0}</span>
              <button className="pv-rule-rm" title="Remove rule" onClick={() => save(rules.filter((x) => x.id !== r.id))}>
                ×
              </button>
            </li>
          ))}
        </ol>
      )}

      <form
        className="nt-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          className="nt-input"
          value={draft}
          maxLength={MAX_PRIVACY_RULE}
          placeholder={rules.length ? "Another rule…" : "What's private? e.g. anything medical: doctors, prescriptions, claims"}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className="settings-btn"
          type="button"
          disabled={!text || busy || !aiAvailable()}
          title={aiAvailable() ? "Which recent threads it would make private" : "Needs a connection"}
          onClick={() => void runPreview()}
        >
          {busy ? "Checking…" : "Preview"}
        </button>
        <button className="settings-btn is-primary" type="submit" disabled={!canAdd}>
          Add
        </button>
      </form>

      {error && <div className="pv-error">{error}</div>}
      {preview && preview.text === text && (
        <div className="pv-threads">
          <div className="pv-preview-head">
            {preview.hits.length === 0 ? "None of your recent threads" : `${preview.hits.length} recent thread${preview.hits.length === 1 ? "" : "s"}`}
          </div>
          {preview.hits.map((h) => (
            <div key={`${h.account_id}:${h.thread_gmail_id}`} className="pv-thread is-static">
              <span className="pv-thread-subject">{h.subject || "(no subject)"}</span>
              <span className="pv-thread-why">{h.why || h.from}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
