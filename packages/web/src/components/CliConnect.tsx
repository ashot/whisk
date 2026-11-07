import React, { useState } from "react";
import { useTracked } from "../store/mailStore";
import { orderedAccounts, privacyRules } from "../store/selectors";
import type { Account } from "../store/types";
import {
  clearCliConnect,
  cliConnectRequest,
  deliverToCli,
  mintDeviceToken,
  type CliConnectRequest,
} from "../sync/cliConnect";
import { TokenCommand } from "./TokenCommand";

// The consent step for `whisk auth`. The browser holds the session, so
// connecting a device is an explicit grant that names the account being
// handed over — never an auto-fire on page load, since a link opened in a
// signed-in browser must not be able to connect a stranger's terminal.

type Phase =
  | { kind: "ask" }
  | { kind: "working" }
  | { kind: "delivered" }
  | { kind: "paste"; token: string }
  | { kind: "error"; message: string };

export function CliConnect({
  request,
  onDone,
}: {
  request: CliConnectRequest;
  onDone: () => void;
}): React.ReactElement {
  const s = useTracked([(s) => s.accounts, (s) => s.clientState, (s) => s.threads]);
  const accounts = orderedAccounts(s.accounts) as Account[];
  const [phase, setPhase] = useState<Phase>({ kind: "ask" });
  // Agents run in terminals, so once anything is private a new terminal
  // starts as an agent login; the person picks Full to see everything there.
  const hasPrivate = privacyRules(s).length > 0 || Object.values(s.threads).some((t) => t.private_mark);
  const [agent, setAgent] = useState(hasPrivate);

  const authorize = async () => {
    setPhase({ kind: "working" });
    let minted;
    try {
      minted = await mintDeviceToken(request.device, { agent });
    } catch (e) {
      setPhase({ kind: "error", message: String((e as Error).message ?? e) });
      return;
    }
    try {
      const delivered = await deliverToCli(request, minted);
      clearCliConnect();
      setPhase(delivered ? { kind: "delivered" } : { kind: "paste", token: minted.token });
    } catch (e) {
      clearCliConnect();
      setPhase({ kind: "error", message: String((e as Error).message ?? e) });
    }
  };

  const dismiss = () => {
    clearCliConnect();
    onDone();
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-mark" aria-hidden>
          ⌘
        </div>
        <h1 className="welcome-title">Connect a terminal</h1>
        {phase.kind === "ask" || phase.kind === "working" ? (
          <>
            <p className="welcome-tag">
              <strong>{request.device}</strong> asked to use Whisk from the command line. It
              will read and send mail as{" "}
              {accounts.map((a, i) => (
                <React.Fragment key={a._id}>
                  {i > 0 && ", "}
                  <code>{a.email}</code>
                </React.Fragment>
              ))}
              .
            </p>
            <div className="cli-access" role="radiogroup" aria-label="Access">
              <button role="radio" aria-checked={agent} className={agent ? "is-on" : ""} onClick={() => setAgent(true)}>
                <strong>Agent</strong>
                <span>Never sees private mail</span>
              </button>
              <button role="radio" aria-checked={!agent} className={!agent ? "is-on" : ""} onClick={() => setAgent(false)}>
                <strong>Full</strong>
                <span>Everything, like this browser</span>
              </button>
            </div>
            <div className="welcome-actions">
              <button
                className="welcome-primary"
                disabled={phase.kind === "working"}
                onClick={() => void authorize()}
              >
                {phase.kind === "working" ? "Connecting…" : "Authorize"}
              </button>
              <button className="welcome-secondary" onClick={dismiss}>
                Not me — cancel
              </button>
            </div>
            <div className="welcome-note">
              Didn't run <code>whisk auth</code>? Cancel. Revoke any terminal later from
              Settings.
            </div>
          </>
        ) : phase.kind === "delivered" ? (
          <>
            <p className="welcome-tag">
              Connected. The terminal has its login — you can close this tab.
            </p>
            <div className="welcome-actions">
              <button className="welcome-secondary" onClick={dismiss}>
                Back to inbox
              </button>
            </div>
          </>
        ) : phase.kind === "paste" ? (
          <>
            <p className="welcome-tag">
              This browser could not reach the terminal (it may be on another machine).
              Finish there by pasting:
            </p>
            <TokenCommand token={phase.token} />
            <div className="welcome-actions">
              <button className="welcome-secondary" onClick={dismiss}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="welcome-error">{phase.message}</div>
            <div className="welcome-actions">
              <button className="welcome-secondary" onClick={dismiss}>
                Back to inbox
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Route hook: the pending request, forgotten once the component serves it. */
export function useCliConnect(): [CliConnectRequest | null, () => void] {
  const [request, setRequest] = useState<CliConnectRequest | null>(cliConnectRequest);
  return [request, () => setRequest(null)];
}
