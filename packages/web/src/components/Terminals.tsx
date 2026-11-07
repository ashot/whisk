import React, { useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@mail/convex/convex/_generated/api";
import { useServerList } from "@mail/shared/src/lib/serverList";
import { convexClient } from "../sync/ConvexSync";
import { mintDeviceToken } from "../sync/cliConnect";
import { relativeDate } from "../lib/format";
import { TokenCommand } from "./TokenCommand";

// Device logins: every terminal (and agent) using `whisk` from the command
// line, with a way to mint one here without the browser handshake, and a
// way to end any of them.

type Device = FunctionReturnType<typeof api.devices.list>[number];

export function Terminals(): React.ReactElement {
  const { rows: devices, change } = useServerList((token) =>
    convexClient().query(api.devices.list, { token }),
  );
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mint = async (agent: boolean) => {
    setBusy(true);
    const result = await change(() => mintDeviceToken(agent ? "agent, pasted from Settings" : "pasted from Settings", { agent }));
    if (result) setMinted(result.token);
    setBusy(false);
  };

  const revoke = (id: Device["_id"]) =>
    change((token) => convexClient().mutation(api.devices.revoke, { token, session_id: id }));

  const setAccess = (id: Device["_id"], hides_private: boolean) =>
    change((token) => convexClient().mutation(api.devices.setAccess, { token, session_id: id, hides_private }));

  return (
    <section className="settings-section">
      <h3 className="help-group-title">Terminals &amp; agents</h3>
      <div className="settings-row">
        <span>
          Use Whisk from the command line. Run <code>whisk auth</code>, or mint a login to
          paste.
        </span>
        <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button className="settings-btn" disabled={busy} onClick={() => void mint(true)} title="Never sees private mail">
            Agent login
          </button>
          <button className="settings-btn" disabled={busy} onClick={() => void mint(false)}>
            Full login
          </button>
        </span>
      </div>
      {minted && (
        <div style={{ marginTop: 8 }}>
          <TokenCommand token={minted} />
        </div>
      )}
      {devices && devices.length > 0 && (
        <div className="settings-devices">
          {devices.map((d) => (
            <div className="settings-device" key={d._id}>
              <span>
                {d.device_name ?? (d.current ? "This browser" : "A device")}
                {d.current && <span className="settings-device-meta"> · this browser</span>}
                <span className="settings-device-meta">
                  {" "}
                  · last seen {relativeDate(d.last_seen_at)}
                </span>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {!d.current && (
                  <span className="pv-access" role="group" aria-label="Access">
                    <button aria-pressed={d.hides_private} title="Never sees private mail" onClick={() => !d.hides_private && void setAccess(d._id, true)}>
                      Agent
                    </button>
                    <button aria-pressed={!d.hides_private} title="Sees everything, private mail included" onClick={() => d.hides_private && void setAccess(d._id, false)}>
                      Full
                    </button>
                  </span>
                )}
                {!d.current && (
                  <button className="settings-btn is-quiet" onClick={() => void revoke(d._id)}>
                    Revoke
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="settings-note">
        A terminal login reads and sends mail as you. An agent login never sees private mail
        and cannot change what is private. Revoke one to end it at once.
      </p>
    </section>
  );
}
