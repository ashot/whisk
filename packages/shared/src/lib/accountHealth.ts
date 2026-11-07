import type { Account } from "../store/types";

// One reading of an account's sync state for every surface that shows it
// (web settings, mobile settings, the rail). The raw sync_error is a Gmail
// API status line plus body — useful to a developer, noise to a person — so
// the well-known failures get a sentence and a remedy.

export type AccountHealth = {
  kind: "ok" | "busy" | "reconnect" | "error";
  /** Short status: "Synced 2m ago", "Syncing…", "Needs reconnect". */
  label: string;
  /** What to do about it, when there is something to do. */
  detail?: string;
};

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function accountHealth(a: Account, now = Date.now()): AccountHealth {
  if (a.provider === "demo") return { kind: "ok", label: "Demo mailbox" };
  if (a.sync_status === "backfilling") {
    return { kind: "busy", label: "Loading mailbox…" };
  }
  if (a.sync_status === "syncing") return { kind: "busy", label: "Syncing…" };
  if (a.sync_status === "error") {
    const err = a.sync_error ?? "";
    if (/insufficient|PERMISSION_DENIED|\(403\)/i.test(err)) {
      return {
        kind: "reconnect",
        label: "Needs reconnect",
        detail:
          "Gmail access was not granted. Reconnect and tick the Gmail box on Google's consent screen.",
      };
    }
    if (/invalid_grant|Token refresh failed|\(401\)/i.test(err)) {
      return {
        kind: "reconnect",
        label: "Needs reconnect",
        detail: "Google revoked Whisk's access. Reconnect to resume syncing.",
      };
    }
    return {
      kind: "error",
      label: "Sync failed",
      detail: err.split("\n")[0].slice(0, 160) || "Unknown error",
    };
  }
  return {
    kind: "ok",
    label: a.last_synced_at ? `Synced ${ago(a.last_synced_at, now)}` : "Connected",
  };
}
