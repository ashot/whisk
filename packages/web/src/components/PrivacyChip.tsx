import React from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import { privacyRules } from "../store/selectors";
import { matchedRules, threadPrivacy } from "@mail/shared/src/lib/privacy";
import type { Thread } from "../store/types";

// A thread's place in private mail, and the hand mark that overrides the
// rules. Private shows as a filled lock; clicking it lets agents see the
// thread. Still being checked shows as such. An open thread offers a faint
// lock that makes it private.

function Lock({ open }: { open?: boolean }): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="7" width="10" height="7.5" rx="1.5" fill={open ? "none" : "currentColor"} />
      <path d={open ? "M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" : "M5.5 7V5a2.5 2.5 0 0 1 5 0v2"} />
    </svg>
  );
}

export function PrivacyChip({ thread: t }: { thread: Thread }): React.ReactElement | null {
  const s = useTracked([(s) => s.clientState]);
  const rules = privacyRules(s);
  const state = threadPrivacy(t, rules);
  const mark = (value: boolean | null, toast: string) => {
    const st = useMailStore.getState();
    st.setPrivate({ thread_gmail_ids: [t.gmail_id], account_id: t.account_id, private: value });
    st.pushToast(toast);
  };

  if (state === "private") {
    const why = t.private_mark ? "Marked private by you" : [matchedRules(t, rules).map((r) => r.text).join("; "), t.private_why].filter(Boolean).join(" · ");
    return (
      <button
        className="row-chip pv-chip is-private"
        title={`${why}. Hidden from agents. Click to let agents see it.`}
        tabIndex={-1}
        onClick={() => mark(t.private_mark && !matchedRules(t, rules).length ? null : false, "Agents can see this conversation")}
      >
        <Lock /> Private
      </button>
    );
  }
  if (state === "pending") {
    return (
      <span className="row-chip pv-chip" title="Being checked against your privacy rules; hidden from agents until then">
        <Lock /> Checking
      </span>
    );
  }
  if (t.private_mark === false && rules.length > 0) {
    return (
      <button className="row-chip pv-chip" title="You let agents see this. Click to hand it back to your privacy rules." tabIndex={-1} onClick={() => mark(null, "Back to your privacy rules")}>
        <Lock open /> Not private
      </button>
    );
  }
  return (
    <button className="pv-chip is-quiet" title="Make private: hide from agents" aria-label="Make private" tabIndex={-1} onClick={() => mark(true, "Private: hidden from agents")}>
      <Lock open />
    </button>
  );
}
