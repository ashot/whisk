import React from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@mail/convex/convex/_generated/api";
import { useServerList } from "@mail/shared/src/lib/serverList";
import { convexClient } from "../sync/ConvexSync";
import { relativeDate } from "../lib/format";

// Apps the person connected through whisk.email/connect (codecast first):
// what each may do, when it last acted, and a way to end it at once. Like
// Terminals, this reads the server directly (useServerList): a revoke only
// means something once the server has it.

type Connection = FunctionReturnType<typeof api.connect.list>[number];

export function ConnectedApps(): React.ReactElement | null {
  const { rows: apps, change } = useServerList((token) =>
    convexClient().query(api.connect.list, { token }),
  );
  const revoke = (id: Connection["_id"]) =>
    change((token) => convexClient().mutation(api.connect.revoke, { token, connection_id: id }));

  // Nothing connected: the section would only explain an absence.
  if (!apps || apps.length === 0) return null;
  return (
    <section className="settings-section">
      <h3 className="help-group-title">Connected apps</h3>
      <div className="settings-devices">
        {apps.map((a) => (
          <div className="settings-device" key={a._id}>
            <span>
              {a.name}
              <span className="settings-device-meta">
                {" "}
                · connected {relativeDate(a.connected_at)} · last used{" "}
                {relativeDate(a.last_used_at)}
              </span>
              <span className="settings-device-meta settings-app-scopes">
                {a.scopes.map((s) => s.label).join(" · ")}
              </span>
              <span className="settings-device-meta settings-app-scopes">{a.reach}</span>
            </span>
            <button className="settings-btn is-quiet" onClick={() => void revoke(a._id)}>
              Revoke
            </button>
          </div>
        ))}
      </div>
      <p className="settings-note">
        A connected app works with your mail and calendar through Whisk, never with your Google
        password. Revoke one to end it at once.
      </p>
    </section>
  );
}
