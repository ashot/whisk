import React, { useState } from "react";
import { defaultFrom, scopedAccount, useMailStore, useTracked } from "../store/mailStore";
import { ACCOUNT_INK, accountColor, orderedAccounts } from "../store/selectors";
import { accountHealth } from "@mail/shared/src/lib/accountHealth";
import type { Account } from "../store/types";
import {
  disconnectAccount,
  gmailAuthUrl,
  openGmailAuth,
  refreshSync,
  signOut,
} from "../sync/ConvexSync";
import { useLocalAuth } from "../sync/localAuth";
import { currentTheme, toggleTheme } from "../lib/theme";
import { initials } from "../lib/format";
import { useRestoreFocus } from "../lib/useRestoreFocus";
import { fromAddress, sendAddresses } from "@mail/shared/src/lib/sendAs";
import { KeyCap } from "./KeyCap";
import { FromPicker } from "./Compose";
import { Terminals } from "./Terminals";
import { PrivacySettings } from "./PrivacySettings";
import { ConnectedApps } from "./ConnectedApps";
import { TopicSettings } from "./TopicSettings";
import { CalendarSettings } from "./CalendarSettings";
import { NotificationSettings } from "./NotificationSettings";

// Everything about the person's session in one place: which mailboxes are
// connected and whether each one is actually syncing, how to fix one that is
// not, and the exits (disconnect a mailbox, sign this device out).

function AccountCard({ account }: { account: Account }): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"sync" | "disconnect" | null>(null);
  const health = accountHealth(account);
  const st = () => useMailStore.getState();
  const gmail = account.provider === "gmail";

  const syncNow = async () => {
    setBusy("sync");
    await refreshSync();
    setBusy(null);
    st().pushToast("Syncing…");
  };
  const reconnect = () => void openGmailAuth(true, account.email);
  const disconnect = async () => {
    setBusy("disconnect");
    try {
      await disconnectAccount(account._id);
    } catch (e) {
      st().pushToast(String((e as Error).message ?? e), "error");
      setBusy(null);
      setConfirming(false);
    }
  };

  return (
    <div className={`settings-account is-${health.kind}`}>
      <span
        className="rail-acct-dot settings-acct-dot"
        style={{ ["--acct" as any]: accountColor(st().accounts, account._id), ["--acct-ink" as any]: ACCOUNT_INK }}
        aria-hidden
      >
        {initials({ name: account.name, email: account.email })}
      </span>
      <div className="settings-account-body">
        <div className="settings-account-email">{account.email}</div>
        <div className="settings-account-status">
          {health.kind === "busy" && <span className="spin" />}
          {health.kind !== "busy" && <span className="settings-status-dot" aria-hidden />}
          {health.label}
        </div>
        {health.detail && <div className="settings-account-detail">{health.detail}</div>}
      </div>
      <div className="settings-account-actions">
        {confirming ? (
          <>
            <span className="settings-confirm-text">
              Revokes Whisk's access and deletes its synced copy. Your mail stays in Gmail.
            </span>
            <button
              className="settings-btn is-danger"
              disabled={busy === "disconnect"}
              onClick={() => void disconnect()}
            >
              {busy === "disconnect" ? "Disconnecting…" : "Yes, disconnect"}
            </button>
            <button className="settings-btn" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <>
            {gmail && health.kind === "reconnect" && (
              <button className="settings-btn is-primary" onClick={reconnect}>
                Reconnect
              </button>
            )}
            {gmail && health.kind !== "reconnect" && (
              <button
                className="settings-btn"
                disabled={busy === "sync" || health.kind === "busy"}
                onClick={() => void syncNow()}
              >
                Sync now
              </button>
            )}
            <button className="settings-btn is-quiet" onClick={() => setConfirming(true)}>
              Disconnect…
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Which address new mail starts from. Replies still answer from the
 *  address the mail was sent to. Hidden when there is only one. */
function DefaultFromRow({ accounts }: { accounts: Account[] }): React.ReactElement | null {
  const s = useTracked([(s) => s.accounts, (s) => s.clientState]);
  if (accounts.flatMap(sendAddresses).length <= 1) return null;
  const account = scopedAccount({ ...s, accountScope: "all" });
  if (!account) return null;
  return (
    <div className="settings-row">
      <span>New mail from</span>
      <FromPicker
        className="nt-input"
        accounts={accounts}
        account={account}
        email={defaultFrom(s)?.email ?? fromAddress(account).email}
        onPick={(a, email) => useMailStore.getState().setClientPref("send_from", { account_id: a._id, email })}
      />
    </div>
  );
}

export function Settings(): React.ReactElement {
  useRestoreFocus();
  const s = useTracked([(s) => s.accounts, (s) => s.clientState]);
  const signedIn = useLocalAuth();
  const accounts = orderedAccounts(s.accounts) as Account[];
  const canAdd = !!gmailAuthUrl(true) || (signedIn && !!gmailAuthUrl());
  const close = () => useMailStore.getState().setSettings(false);
  // clientState is tracked above, so a toggle from anywhere re-renders this.
  const theme = currentTheme();

  return (
    <div className="overlay" onClick={close}>
      <div className="help settings" onClick={(e) => e.stopPropagation()}>
        <header className="help-head">
          <h2 className="help-title">Settings</h2>
          <span className="help-sub">
            <KeyCap spec="mod+," /> or <KeyCap spec="escape" /> closes
          </span>
          <button className="settings-btn help-close" onClick={close}>Close</button>
        </header>

        <section className="settings-section">
          <h3 className="help-group-title">Accounts</h3>
          <div className="settings-accounts">
            {accounts.map((a) => (
              <AccountCard key={a._id} account={a} />
            ))}
          </div>
          <DefaultFromRow accounts={accounts} />
          {canAdd && (
            <button className="settings-add" onClick={() => void openGmailAuth(true)}>
              + Add another Gmail account
            </button>
          )}
          <p className="settings-note">
            Mail syncs in the background every two minutes while a mailbox is connected, and
            on the spot when you open Whisk.
          </p>
        </section>

        <NotificationSettings />
        <TopicSettings />
        <CalendarSettings />

        <section className="settings-section">
          <h3 className="help-group-title">Appearance</h3>
          <div className="settings-row">
            <span>Theme</span>
            <button className="settings-btn" onClick={() => toggleTheme()}>
              {theme === "dark" ? "Dark" : "Light"} · switch
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h3 className="help-group-title">Whisk</h3>
          <div className="settings-row">
            <span>Memories — what Whisk knows about you</span>
            <button
              className="settings-btn"
              onClick={() => {
                close();
                useMailStore.getState().setMemories(true);
              }}
            >
              Open
            </button>
          </div>
        </section>

        <PrivacySettings />

        <ConnectedApps />

        <Terminals />

        <section className="settings-section">
          <h3 className="help-group-title">This device</h3>
          <div className="settings-row">
            <span>Sign out here. Your mailboxes stay connected for other devices.</span>
            <button className="settings-btn is-quiet" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </section>

        <footer className="settings-foot">
          <a href="/privacy/" target="_blank" rel="noreferrer">
            Privacy
          </a>
          <a href="/terms/" target="_blank" rel="noreferrer">
            Terms
          </a>
          <a href="mailto:ashot@almostcandid.com">Contact</a>
        </footer>
      </div>
    </div>
  );
}
