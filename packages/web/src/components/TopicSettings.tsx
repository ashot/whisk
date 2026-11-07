import React from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import { inScope, orderedAccounts } from "../store/selectors";
import type { Account } from "../store/types";
import { GroupingProgress } from "./TopicRows";
import { KeyCap } from "./KeyCap";

/** The two switches behind topics: whether new mail is grouped as it
 *  arrives, and a fresh start. Everything else about a topic is on the
 *  topic itself. */
export function TopicSettings(): React.ReactElement {
  const s = useTracked([(s) => s.accounts, (s) => s.accountScope, (s) => s.clientState]);
  const st = useMailStore.getState();
  const settings = (s.clientState.clustering ?? s.clientState.prefs?.clustering ?? {}) as { enabled?: boolean; granularity?: string };
  const on = settings.enabled !== false;
  const accounts = (orderedAccounts(s.accounts) as Account[]).filter((a) => inScope({ account_id: a._id }, s.accountScope));
  const busy = accounts.some((a) => a.clustering);
  const errors = accounts.filter((a) => a.cluster_error);
  // Regroup while auto-group is off turns it back on for that pass: the
  // person asked for topics, so a greyed button would only send them hunting.
  const regroup = () => { if (!on) st.setClientPref("clustering", { ...settings, enabled: true }); accounts.forEach((a) => st.regroupClusters({ fresh: true, account_id: a._id })); };
  return (
    <section className="settings-section">
      <h3 className="help-group-title">Topics</h3>
      <div className="settings-row">
        <div>
          <div className="nt-master-title">Group new mail as it arrives</div>
          <p className="nt-hint">
            Whisk reads new inbox mail and files it into topics. Press <KeyCap spec="v" /> in the inbox to see them. Off, the inbox stays as it is until you regroup.
          </p>
        </div>
        <button type="button" className={`nt-switch${on ? " is-on" : ""}`} role="switch" aria-label="Group new mail as it arrives" aria-checked={on} onClick={() => { st.setClientPref("clustering", { ...settings, enabled: !on }); if (!on) accounts.forEach((a) => st.regroupClusters({ fresh: false, account_id: a._id })); }}>
          <span className="nt-switch-knob" />
        </button>
      </div>
      <div className="settings-row">
        <div>
          <div className="nt-master-title">Start over</div>
          <p className="nt-hint">Rediscover topics from scratch. Anything you named, moved or hid stays as you left it.</p>
        </div>
        <button className="settings-btn" disabled={busy} onClick={regroup}>{busy ? "Grouping…" : "Regroup"}</button>
      </div>
      {busy && <GroupingProgress accounts={accounts} many={accounts.length > 1} />}
      {errors.map((a) => <p className="topic-error is-inline" role="alert" key={a._id}>{accounts.length > 1 ? `${a.email}: ` : ""}{a.cluster_error}</p>)}
    </section>
  );
}
