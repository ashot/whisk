import type { PlatformConfig } from "@mail/platform";

// The mail app's local-first registry — the single place where the platform
// learns what this app syncs, persists, protects, and dispatches.
export const MAIL_PLATFORM_CONFIG: PlatformConfig = {
  dbName: "mail-store",
  dbVersion: 1,
  registry: {
    calendars: { persistence: { kind: "collection", key: "calendars" }, localFirst: true },
    events: { persistence: { kind: "collection", key: "events" }, localFirst: true },
    threads: {
      persistence: { kind: "collection", key: "threads" },
      localFirst: true,
    },
    labels: {
      persistence: { kind: "collection", key: "labels" },
      localFirst: true,
    },
    accounts: {
      persistence: { kind: "collection", key: "accounts" },
      // Live-synced roster — a stale cached roster must never clobber a
      // fresh one; only fill an empty slot at boot.
      hydration: { merge: "fill" },
    },
    memories: {
      persistence: { kind: "collection", key: "memories" },
      localFirst: true,
    },
    reminders: {
      persistence: { kind: "collection", key: "reminders" },
      localFirst: true,
    },
    clusters: {
      persistence: { kind: "collection", key: "clusters" },
      localFirst: true,
    },
    filters: {
      persistence: { kind: "collection", key: "filters" },
      localFirst: true,
    },
    drafts: {
      persistence: { kind: "meta", key: "drafts" },
      localFirst: true,
    },
    clientState: {
      persistence: { kind: "meta", key: "clientState" },
      dispatchTable: { table: "client_state", kind: "singleton" },
    },
    pending: {
      persistence: { kind: "meta", key: "pending" },
    },
    syncMeta: {
      persistence: { kind: "meta", key: "syncMeta" },
    },
  },
  syncRegistry: {
    calendars: { isDelta: true },
    events: { isDelta: true, altKey: "client_id" },
    // Delta overlays: the live window is the server's recent slice; rows it
    // stops sending stay cached locally (search/archive keeps working offline).
    // altKey supersede: an optimistic sent-thread stub (keyed by its client_id)
    // is rekeyed onto the real server thread row when it syncs back.
    threads: { isDelta: true, altKey: "client_id" },
    labels: { isDelta: true },
    memories: { isDelta: true },
    reminders: { isDelta: true },
    clusters: { isDelta: true },
    filters: { isDelta: true },
    // The session's account roster: the server list is authoritative, so a
    // plain (non-delta) collection replace is the right merge.
    accounts: {},
    clientState: {
      kind: "singleton",
      // Prefs are per-key local-first: an optimistic toggle must not be
      // clobbered by a stale echo, while keys only the server has still land.
      merge: {
        theme: "local_wins",
        density: "local_wins",
        rail_collapsed: "local_wins",
        notifications: "local_wins",
        calendar: "local_wins",
        inbox: "local_wins",
        clustering: "local_wins",
        send_from: "local_wins",
        lenses: "local_wins",
        privacy_rules: "local_wins",
      },
    },
  },
  detailTables: {
    threadMessages: { keyField: "thread_gmail_id" },
  },
  // When the sent-thread stub is rekeyed onto its server row, move the view
  // pointers that referenced the stub id so the user stays on the thread.
  rekeyExtra: (draft: any, oldId: string, newId: string) => {
    if (draft.focusedThreadId === oldId) draft.focusedThreadId = newId;
    if (draft.openThreadId === oldId) draft.openThreadId = newId;
  },
  // User-authored content never drops from the outbox. applyThreadOps is here
  // too: a dropped archive/read/label op would otherwise leave the client
  // permanently diverged from the server with an immortal pending lock. The
  // server side effect is idempotent (label deltas re-apply cleanly).
  mustDeliverActions: new Set([
    "sendMessage",
    "saveDraft",
    "deleteDraft",
    "applyThreadOps",
    // A hand placement is the person's word and an example the model
    // learns from; a lens save carries the lens itself.
    "setLensMark",
    "saveLens",
    // What is private is the person's word; a dropped save or mark would
    // leave agents seeing mail the person meant to hide.
    "savePrivacyRules",
    "setPrivate",
  ]),
  // Draft autosaves are full-value LWW per draft — keep only the newest row
  // per draft in the durable queue.
  outboxCoalesceKeys: {
    saveDraft: (args) => {
      const d = args[0];
      return d && typeof d.client_id === "string" ? `saveDraft:${d.client_id}` : null;
    },
    setClientPref: (args) =>
      typeof args[0] === "string" ? `setClientPref:${args[0]}` : null,
  },
};
