import { useEffect } from "react";
import { AppState } from "react-native";
import * as Crypto from "expo-crypto";
import { api } from "@mail/convex/convex/_generated/api";
import { createKVCache, createPersistence, deriveRegistryMaps } from "@mail/platform";
import { drainDeltaPages } from "@mail/shared/src/store/deltaPages";
import { mailStore } from "@mail/shared/src/store/mailStore";
import { MAIL_PLATFORM_CONFIG } from "@mail/shared/src/store/registry";
import { setRemoteSearch, type RemoteSearchPage } from "@mail/shared/src/store/searchBridge";
import { setHeadersFetcher } from "@mail/shared/src/store/headersBridge";
import { setPlatformEnv } from "@mail/shared/src/env";
import { convexClient } from "./convex";
import { sqliteKV } from "./kv";
import { readLogin, restoreLogin, saveLogin } from "./login";

// The native mirror of web's ConvexSync: persistence + token restore + live
// subscriptions + dispatch binding, minus everything DOM. The store itself is
// the same module the web app runs.

// Hermes has no crypto.randomUUID; the store mints draft ids with it.
const g = globalThis as any;
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.randomUUID !== "function") {
  g.crypto.randomUUID = () => Crypto.randomUUID();
}

// The shared store persists the token through this seam: keychain here, where
// the web default is localStorage. Module scope so it's set before any action.
setPlatformEnv({
  saveToken: (token) => {
    saveLogin(token).catch((e) => console.warn("[login] could not save the token", e));
  },
  uuid: () => Crypto.randomUUID(),
});

/** The stored login, readable before the cache has hydrated, so work that
 *  only needs the network (a tapped push) can start at launch. */
export function storedToken(): Promise<string | null> {
  return readLogin().catch(() => null);
}

/** Which mail a thread row id names on the server: the thread's Gmail id and
 *  its mailbox. The local row knows; a push names a thread before its row has
 *  synced, so it leaves the answer here. */
export type ThreadTarget = { gmail_id: string; account_id?: string };
const named = new Map<string, ThreadTarget>();

export function nameThread(id: string, target: ThreadTarget): void {
  named.set(id, target);
}

export function threadTarget(id: string | null | undefined, s: any = mailStore.getState()): ThreadTarget | null {
  if (!id) return null;
  const row = s.threads[id];
  return row ? { gmail_id: row.gmail_id, account_id: row.account_id } : named.get(id) ?? null;
}

// accountId scopes the read to the thread's own mailbox: one indexed read
// on the server, and correct when two accounts share a gmail_id.
const messagesArgs = (token: string, target: ThreadTarget) => ({
  token,
  threadGmailId: target.gmail_id,
  accountId: target.account_id as any,
});
const keepMessages = (target: ThreadTarget) => (messages: any) =>
  mailStore.getState().syncDetail("threadMessages", target.gmail_id, messages);

/** One read of a thread's messages into the local cache, ahead of the open.
 *  The read leaves now; its answer is kept once `ready` settles. */
export async function loadThreadMessages(token: string, target: ThreadTarget, ready?: Promise<unknown>): Promise<void> {
  const [messages] = await Promise.all([convexClient().query(api.sync.threadMessages, messagesArgs(token, target)), ready]);
  keepMessages(target)(messages);
}

let booted = false;
const maps = deriveRegistryMaps(MAIL_PLATFORM_CONFIG.registry);
const kvCache = createKVCache(MAIL_PLATFORM_CONFIG, sqliteKV, maps);

/** Buffered cache writes land in SQLite now. The background push task calls
 *  this before iOS suspends the process, so what it fetched survives. */
export function flushCache(): void {
  kvCache.flushAll();
}

/** Hydrate the store from the cache and restore the login. Idempotent; the
 *  app calls it on mount, the background push task calls it with no app. */
export function boot(): void {
  if (booted) return;
  booted = true;

  const persistence = createPersistence(
    MAIL_PLATFORM_CONFIG,
    mailStore as never,
    undefined,
    maps,
    kvCache,
  );
  void persistence.hydrate().then(async () => {
    // Token lives in the keychain, not the KV cache — restore it after
    // hydration so setHydrated ordering matches the web boot. Hydration
    // waits for the keychain: booting without it would show the welcome
    // screen to someone who is signed in.
    const token = await restoreLogin();
    if (token) mailStore.getState().setAuthToken(token);
    mailStore.getState().setHydrated();
  });

  // Buffered KV writes must land before a background kill.
  AppState.addEventListener("change", (next) => {
    if (next === "background" || next === "inactive") kvCache.flushAll();
  });

  setRemoteSearch(async (q: string, cursor: string | null) => {
    const token = mailStore.getState().authToken;
    if (!token) return { rows: [], cursor: null };
    // The server row is the shared Thread shape with looser literal types.
    return (await convexClient().action(api.search.runFullSearch, {
      token,
      q,
      cursor: cursor ?? undefined,
    })) as RemoteSearchPage;
  });

  setHeadersFetcher(async (messageGmailId) =>
    await convexClient().action(api.gmail.attachments.messageHeaders, {
      token: mailStore.getState().authToken ?? undefined,
      messageGmailId,
    }),
  );
}

export function useMailSync(): void {
  const token = (mailStore as any)((s: any) => s.authToken) as string | null;

  useEffect(boot, []);

  // Dispatch binding + core subscriptions, re-wired per token.
  useEffect(() => {
    if (!token) return;
    const c = convexClient();
    const owner = {};
    (mailStore.getState() as any)._setDispatch(
      (action: string, args: any, patches?: any, result?: any) =>
        c.mutation(api.dispatch.dispatch, { token, action, args, patches, result }),
      { owner },
    );

    // The server answers a token it no longer knows with Unauthorized. Drop
    // it so the welcome screen shows instead of an endless quiet frame.
    const onAuthError = (e: Error) => {
      if (/Unauthorized/i.test(e.message)) mailStore.getState().setAuthToken(null);
    };

    const subs = [
      c.onUpdate(api.sync.getAccount, { token }, (payload: any) => {
        // Envelope mid-migration to multi-account: prefer the accounts
        // collection, fall back to the old singleton shape.
        const st = mailStore.getState() as any;
        if (typeof st.syncTable !== "function") return;
        if ("accounts" in st) {
          st.syncTable("accounts", payload.accounts ?? [payload.account]);
        } else {
          st.syncTable("account", payload.account);
        }
        if (payload.client_state) st.syncTable("clientState", payload.client_state);
        // A revoked scoped account falls back to the unified view.
        const cur = mailStore.getState() as any;
        if (
          cur.accountScope &&
          cur.accountScope !== "all" &&
          !(payload.accounts ?? [payload.account]).some(
            (a: { _id: string }) => a._id === cur.accountScope,
          )
        ) {
          cur.setAccountScope?.("all");
        }
      }, onAuthError),
      c.onUpdate(api.sync.listLabels, { token }, (labels: any) => {
        mailStore.getState().syncTable("labels", labels);
      }),
      c.onUpdate(api.sync.listThreads, { token }, (page: any) => {
        // { rows, nextSince, hasMore }: apply the first page, then follow
        // nextSince until the server reports the delta drained.
        void drainDeltaPages(
          page,
          (since) => c.query(api.sync.listThreads, { token, since }),
          (rows) => mailStore.getState().syncTable("threads", rows),
        ).catch(() => {}); // A lost page re-arrives on the next server tick.
      }),
    ];

    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        void c.mutation(api.sync.refresh, { token }).catch(() => {});
        (mailStore.getState() as any)._drainOutbox?.();
      }
    });

    return () => {
      for (const unsub of subs) unsub();
      sub.remove();
      (mailStore.getState() as any)._clearDispatch(owner);
    };
  }, [token]);

  // Open-thread messages subscription (openThreadId is the row _id; the query
  // keys on the thread's gmail_id). The target is read as two strings so the
  // subscription starts when a thread opened ahead of its row gets the row,
  // and does not restart when the row merely changes.
  const gmailId = (mailStore as any)((s: any) => threadTarget(s.openThreadId, s)?.gmail_id ?? null) as string | null;
  const accountId = (mailStore as any)((s: any) => threadTarget(s.openThreadId, s)?.account_id) as string | undefined;
  useEffect(() => {
    if (!token || !gmailId) return;
    const target = { gmail_id: gmailId, account_id: accountId };
    return convexClient().onUpdate(api.sync.threadMessages, messagesArgs(token, target), keepMessages(target));
  }, [gmailId, accountId, token]);
}
