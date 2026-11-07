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

  const mint = async () => {
    setBusy(true);
    const result = await change(() => mintDeviceToken("pasted from Settings"));
    if (result) setMinted(result.token);
    setBusy(false);
  };

  const revoke = (id: Device["_id"]) =>
    change((token) => convexClient().mutation(api.devices.revoke, { token, session_id: id }));

  return (
    <section className="settings-section">
      <h3 className="help-group-title">Terminals &amp; agents</h3>
      <div className="settings-row">
        <span>
          Use Whisk from the command line. Run <code>whisk auth</code>, or mint a login to
          paste.
        </span>
        <button className="settings-btn" disabled={busy} onClick={() => void mint()}>
          {busy ? "Minting…" : "Mint a login"}
        </button>
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
              {!d.current && (
                <button className="settings-btn is-quiet" onClick={() => void revoke(d._id)}>
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="settings-note">
        A terminal login reads and sends mail as you. Revoke one to end it at once.
      </p>
    </section>
  );
}
