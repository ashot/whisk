import React, { useEffect, useState } from "react";
import { serverErrorMessage } from "@mail/shared/src/lib/serverError";
import { useTracked } from "../store/mailStore";
import { orderedAccounts } from "../store/selectors";
import type { Account } from "../store/types";
import {
  appConnectRequest,
  approveApp,
  clearAppConnect,
  describeApp,
  type AppConnectRequest,
  type AppDescription,
} from "../sync/appConnect";
import { gmailAuthUrl, signInWithGoogle } from "../sync/ConvexSync";
import { GoogleMark } from "./Welcome";

// The one screen another app (codecast) sends a person to: it names the app,
// says in plain words what it may do with their mail and calendar, and waits
// for a click. Never an auto-approve on load: a link opened in a signed-in
// browser must not be able to connect anything by itself.
//
// Someone with no mailbox here yet gets the same card with Whisk's Google
// sign-in on it, not the marketing page: they came to connect an app, and the
// request is still pending when the sign-in returns (sync/stashedRequest.ts).

type Phase =
  | { kind: "loading" }
  | { kind: "ask"; app: AppDescription }
  | { kind: "leaving"; app: AppDescription }
  | { kind: "error"; message: string };

export function AppConnect({
  request,
  onDone,
}: {
  request: AppConnectRequest;
  onDone: () => void;
}): React.ReactElement {
  const s = useTracked([(s) => s.accounts]);
  const accounts = orderedAccounts(s.accounts) as Account[];
  const signedIn = accounts.length > 0;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    describeApp(request).then(
      (app) => live && setPhase({ kind: "ask", app }),
      (e) => live && setPhase({ kind: "error", message: serverErrorMessage(e) }),
    );
    return () => {
      live = false;
    };
  }, [request]);

  const approve = async (app: AppDescription) => {
    setPhase({ kind: "leaving", app });
    try {
      const { redirect } = await approveApp(request);
      clearAppConnect();
      window.location.assign(redirect);
    } catch (e) {
      setPhase({ kind: "error", message: serverErrorMessage(e) });
    }
  };

  const decline = (app: AppDescription) => {
    clearAppConnect();
    window.location.assign(app.decline_url);
  };

  const dismiss = () => {
    clearAppConnect();
    onDone();
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-mark" aria-hidden>
          ⇄
        </div>
        {phase.kind === "loading" ? (
          <p className="welcome-tag">
            <span className="spin" /> One moment…
          </p>
        ) : phase.kind === "error" ? (
          <>
            <h1 className="welcome-title">Can't connect</h1>
            <div className="welcome-error">{phase.message}</div>
            <div className="welcome-actions">
              <button className="welcome-secondary" onClick={dismiss}>
                Back to Whisk
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 className="welcome-title">Connect {phase.app.name}</h1>
            {signedIn ? (
              <>
                <p className="welcome-tag">
                  {phase.app.blurb} {phase.app.reach} Today that is{" "}
                  {accounts.map((a, i) => (
                    <React.Fragment key={a._id}>
                      {i > 0 && ", "}
                      <code>{a.email}</code>
                    </React.Fragment>
                  ))}
                  .
                </p>
                <ul className="connect-scopes">
                  {phase.app.scopes.map((s) => (
                    <li key={s.scope}>{s.label}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="welcome-tag">
                {phase.app.blurb} Whisk is where your mail lives, so sign in with the Google
                account whose mail and calendar {phase.app.name} should work with.
              </p>
            )}
            <div className="welcome-actions">
              {signedIn ? (
                <button
                  className="welcome-primary"
                  disabled={phase.kind === "leaving"}
                  onClick={() => void approve(phase.app)}
                >
                  {phase.kind === "leaving" ? `Returning to ${phase.app.name}…` : "Allow"}
                </button>
              ) : (
                <button className="welcome-primary" disabled={!gmailAuthUrl()} onClick={signInWithGoogle}>
                  <GoogleMark />
                  Continue with Google
                </button>
              )}
              <button
                className="welcome-secondary"
                disabled={phase.kind === "leaving"}
                onClick={() => decline(phase.app)}
              >
                Not now
              </button>
            </div>
            <div className="welcome-note">
              {signedIn
                ? `${phase.app.name} never sees your Google password or keys; it asks Whisk. Turn it off any time in Whisk's Settings, under Connected apps.`
                : `Next you see exactly what ${phase.app.name} may do, before you allow it. It never sees your Google password or keys.`}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Route hook: the pending request, forgotten once the component serves it. */
export function useAppConnect(): [AppConnectRequest | null, () => void] {
  const [request, setRequest] = useState<AppConnectRequest | null>(appConnectRequest);
  return [request, () => setRequest(null)];
}
