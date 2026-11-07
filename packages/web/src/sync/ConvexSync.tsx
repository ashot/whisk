import { useEffect } from "react";
import { ConvexClient } from "convex/browser";
import { useAuthToken } from "@convex-dev/auth/react";
import { api } from "@mail/convex/convex/_generated/api";
import { createPersistence } from "@mail/platform";
import { readAuthMessage } from "./authMessage";
import { durableAuth, localAuth, storedAuthJwt } from "./localAuth";
import { drainDeltaPages } from "@mail/shared/src/store/deltaPages";
import { setAiClient } from "@mail/shared/src/store/aiBridge";
import { mailStore, useTracked } from "../store/mailStore";
import { MAIL_PLATFORM_CONFIG } from "../store/registry";
import { setRemoteSearch } from "../store/searchBridge";
import type { Attachment } from "../store/types";
import type { RemoteSearchPage } from "../store/searchBridge";
import { authOrigin, desktopBridge } from "../lib/desktopBridge";

// One client for the whole app. Subscriptions write through syncTable; user
// actions dispatch through the platform middleware into api.dispatch.dispatch.

const CONVEX_URL: string =
  (import.meta as any).env?.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const CONVEX_SITE_URL: string | undefined = (import.meta as any).env
  ?.VITE_CONVEX_SITE_URL;

let client: ConvexClient | null = null;
export function convexClient(): ConvexClient {
  if (!client) client = new ConvexClient(CONVEX_URL);
  return client;
}

// The shape ConvexAuthProvider needs, bridged onto the app's single
// ConvexClient so the sign-in actions and the JWT it maintains ride the same
// websocket every query and mutation uses. The provider is typed against
// ConvexReactClient but only touches action/setAuth/clearAuth/address.
let authAdapter: unknown = null;
export function authProviderClient(): any {
  if (!authAdapter) {
    const c = convexClient();
    authAdapter = {
      address: CONVEX_URL,
      options: {},
      action: (fn: unknown, args: unknown) => c.action(fn as any, args as any),
      setAuth: (
        fetchToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>,
        onChange?: (authed: boolean) => void,
      ) => c.setAuth(fetchToken, onChange),
      clearAuth: () => c.setAuth(async () => null),
    };
  }
  return authAdapter;
}

export function gmailAuthUrl(attach = false, hint?: string): string | null {
  if (!CONVEX_SITE_URL) return null;
  // The backend fails closed unless we name our own origin; it echoes the
  // token back only to origins on its allowlist.
  let url = `${CONVEX_SITE_URL}/gmail/auth?origin=${encodeURIComponent(authOrigin())}`;
  // A reconnect names the mailbox so Google preselects it.
  if (hint) url += `&hint=${encodeURIComponent(hint)}`;
  // Adding an account to a signed-in session: pass the session token so the
  // callback attaches the new mailbox instead of replacing the session.
  if (attach) {
    const token = mailStore.getState().authToken;
    if (!token) return null;
    url += `&attach=${encodeURIComponent(token)}`;
  }
  return url;
}

/**
 * The one sign-in: Google consent for the mailbox, in this tab. The callback
 * lands back on our origin with the session token in the URL fragment, which
 * consumeAuthFragment() picks up before the app mounts. Signing in with an
 * address that already belongs to a user recovers that user's whole roster.
 */
export function signInWithGoogle(): void {
  const url = gmailAuthUrl();
  if (!url) return;
  // Desktop: consent runs in the system browser (the person's Google session
  // lives there) and the callback returns through the whisk:// deep link.
  const bridge = desktopBridge();
  if (bridge) void bridge.openExternal(url);
  else window.location.assign(`${url}&mode=redirect`);
}

/**
 * Consume an OAuth result delivered in the URL fragment (`#token=…`,
 * `#attached=1` or `#error=…`). Must run before React mounts: the hash router
 * would otherwise read the fragment as a view name. Clears the fragment either
 * way so the token never lingers in history. The desktop shell passes the
 * fragment in — its callback arrives through the app's URL scheme.
 */
export function consumeAuthFragment(hash = window.location.hash.slice(1)): void {
  if (!/^(token|error|attached)=/.test(hash)) return;
  const params = new URLSearchParams(hash);
  if (window.location.hash.slice(1) === hash) history.replaceState(null, "", "#inbox");
  const token = params.get("token");
  if (token) {
    mailStore.getState().setAuthToken(token);
    return;
  }
  if (params.get("attached")) {
    mailStore.getState().pushToast("Account connected — syncing…");
    void refreshSync();
    return;
  }
  const error = params.get("error");
  if (error) mailStore.getState().pushToast(error, "error");
}

/**
 * Open the Gmail consent popup. A legacy-token session rides the token as
 * before. A Convex Auth session holds no opaque token, so EVERY connect is an
 * attach to the signed-in user, carried by a single-use server-minted ticket.
 * The popup opens synchronously (before the ticket round trip) so the click
 * stays inside the browser's popup allowance, then navigates.
 */
export async function openGmailAuth(attach = false, hint?: string): Promise<void> {
  if (!CONVEX_SITE_URL) return;
  const legacy = mailStore.getState().authToken;
  if (legacy || !localAuth.hasStoredAuthToken()) {
    const url = gmailAuthUrl(attach, hint);
    if (url) window.open(url, "mail-oauth", "width=520,height=680");
    return;
  }
  const popup = window.open("about:blank", "mail-oauth", "width=520,height=680");
  try {
    const { ticket } = await convexClient().mutation(
      api.gmail.oauth.mintAttachTicket,
      {},
    );
    const url = `${gmailAuthUrl(false, hint)}&attach=${encodeURIComponent(ticket)}`;
    if (popup) popup.location.href = url;
    else window.open(url, "mail-oauth", "width=520,height=680");
  } catch (e) {
    popup?.close();
    mailStore.getState().pushToast("Could not start the Gmail connect");
  }
}

/** Streaming URL for one attachment (or a cid: inline image) of a message.
 *  Null until the account is authed or when no backend site is configured. */
export function attachmentUrl(
  messageGmailId: string,
  part: { attachment?: Attachment; cid?: string },
): string | null {
  // Legacy token first; a Convex Auth session sends its JWT instead (an
  // <img> cannot set headers, so the backend verifies it from the query).
  const token = mailStore.getState().authToken ?? storedAuthJwt();
  if (!CONVEX_SITE_URL || !token) return null;
  const params = new URLSearchParams({ token, message: messageGmailId });
  if (part.attachment) {
    params.set("id", part.attachment.gmail_attachment_id);
    params.set("name", part.attachment.filename);
  }
  if (part.cid) params.set("cid", part.cid);
  return `${CONVEX_SITE_URL}/gmail/attachment?${params.toString()}`;
}

export async function seedDemo(): Promise<void> {
  const { token } = await convexClient().mutation(api.demo.seed, {});
  // A signed-in (Convex Auth) caller gets no token back — the mailbox joined
  // their roster and arrives through the live subscription.
  if (token) mailStore.getState().setAuthToken(token);
}

/** Ask the server for an incremental pass on every connected mailbox now,
 *  instead of waiting for the two minute cron. */
export function refreshSync(): Promise<unknown> {
  return convexClient()
    .mutation(api.sync.refresh, {
      token: mailStore.getState().authToken ?? undefined,
    })
    .catch(() => {});
}

/** Drop everything this device holds: the login token and the local cache.
 *  The Convex Auth JWT is NOT purged here — disconnecting the last mailbox
 *  must not sign the person out of their Google identity. */
export async function signOutLocal(): Promise<void> {
  mailStore.getState().setAuthToken(null);
  await persistenceRef?.cache?.purgeLocalCache();
  // A clean slate beats surgically unwinding every store slice.
  window.location.reload();
}

/** End this device's login, on the server and locally. */
export async function signOut(): Promise<void> {
  const token = mailStore.getState().authToken;
  if (token) {
    await convexClient()
      .mutation(api.dispatch.dispatch, { token, action: "signOut", args: [{}] })
      .catch(() => {}); // Local sign-out proceeds even if the server is down.
  }
  if (localAuth.hasStoredAuthToken()) {
    // Explicit sign-out is the one place the durable auth values go too
    // (removeItem alone deliberately keeps the IndexedDB refresh token).
    await convexClient()
      .action(api.auth.signOut, {})
      .catch(() => {});
    await durableAuth.purgeDurableAuthValues(localAuth.keys).catch(() => {});
  }
  await signOutLocal();
}

/**
 * Disconnect an account: the server revokes the Google grant and deletes the
 * mirrored mailbox. When it was the last account, the session is over —
 * finish with a full local sign-out.
 */
export async function disconnectAccount(accountId: string): Promise<void> {
  const token = mailStore.getState().authToken;
  if (!token) return;
  const result = await convexClient().mutation(api.dispatch.dispatch, {
    token,
    action: "disconnectAccount",
    args: [{ account_id: accountId }],
  });
  if (result && result.remaining === 0) {
    await signOutLocal();
    return;
  }
  mailStore.getState().pushToast("Account disconnected — synced data deleted");
}

let persistenceStarted = false;
let persistenceRef: ReturnType<typeof createPersistence> | null = null;

export function ConvexSync(): null {
  const s = useTracked([
    (s) => s.authToken,
    (s) => {
      const t = s.openThreadId ? s.threads[s.openThreadId] : null;
      return t?.gmail_id ?? null;
    },
  ]);
  // The Convex Auth JWT, from the provider's context. Subscriptions gate on
  // it so they start only after the provider has read storage and handed the
  // token to the client — subscribing earlier answers Unauthorized once and
  // then re-runs, which is noise, not auth.
  const jwt = useAuthToken();
  const jwtAuthed = jwt !== null;

  // Boot: persistence + token restore + oauth postMessage listener.
  useEffect(() => {
    if (!persistenceStarted) {
      persistenceStarted = true;
      // Cast: zustand v5 types setState's `replace` param narrowly; the
      // persistence layer only ever calls the partial form.
      const persistence = createPersistence(MAIL_PLATFORM_CONFIG, mailStore as never);
      persistenceRef = persistence;
      void persistence.hydrate().then(() => {
        mailStore.getState().setHydrated();
      });
    }
    try {
      const token = localStorage.getItem("mail:token");
      if (token) mailStore.getState().setAuthToken(token);
      else mailStore.getState().setHydrated();
    } catch {}
    // The OAuth popup posts the token back here. Accept it ONLY from our own
    // Convex site origin and ONLY in the exact shape the OAuth page sends —
    // otherwise any page that holds a handle to this window could inject a
    // token and swap the user onto a mailbox the attacker controls.
    const expectedOrigin = CONVEX_SITE_URL ? new URL(CONVEX_SITE_URL).origin : null;
    const onMessage = (e: MessageEvent) => {
      const msg = readAuthMessage(e, expectedOrigin);
      if (!msg) return;
      if (msg.kind === "token") {
        mailStore.getState().setAuthToken(msg.token);
        return;
      }
      // An attach adds an account to the caller's roster (token session or
      // signed-in user); the getAccount subscription delivers the grown
      // roster on its own.
      mailStore.getState().pushToast("Account connected — syncing…");
      void refreshSync();
    };
    window.addEventListener("message", onMessage);
    // The store's commitSearch reaches the network through this seam.
    setRemoteSearch(async (q, cursor) => {
      const st = mailStore.getState();
      const token = st.authToken;
      if (!token && !localAuth.hasStoredAuthToken()) return { rows: [], cursor: null };
      // A scoped search stays in its account; unified searches everything.
      const accountId = st.accountScope !== "all" ? st.accountScope : undefined;
      // The server row is the shared Thread shape with looser literal types.
      return (await convexClient().action(api.search.runFullSearch, {
        token: token ?? undefined,
        q,
        accountId: accountId as any,
        cursor: cursor ?? undefined,
      })) as RemoteSearchPage;
    });
    // The store's AI gestures reach the model through this seam. Token is
    // read at call time, like remoteSearch.
    const tok = () => mailStore.getState().authToken ?? undefined;
    setAiClient({
      parseFilter: ({ text, accountId }) => convexClient().action(api.ai.actions.parseFilter, { token: tok(), text, accountId: accountId as any }),
      previewFilter: ({ condition, accountId, limit }) => convexClient().action(api.ai.actions.previewFilter, { token: tok(), condition, accountId: accountId as any, limit }),
      previewLens: ({ name, policy, accountId, limit }) => convexClient().action(api.ai.actions.previewLens, { token: tok(), name, policy, accountId: accountId as any, limit }),
      draftReply: ({ threadGmailId, accountId, instruction }) =>
        convexClient().action(api.ai.actions.draftReply, {
          token: tok(),
          threadGmailId,
          accountId: accountId as any,
          instruction,
        }),
      summarizeThread: ({ threadGmailId, accountId, timeoutMs, latest }) =>
        convexClient().action(api.ai.actions.summarizeThread, {
          token: tok(),
          threadGmailId,
          accountId: accountId as any,
          timeoutMs,
          latest,
        }),
      suggestReplies: ({ threadGmailId, accountId }) =>
        convexClient().action(api.ai.actions.suggestReplies, {
          token: tok(),
          threadGmailId,
          accountId: accountId as any,
        }),
    });
    return () => {
      window.removeEventListener("message", onMessage);
      setRemoteSearch(null);
      setAiClient(null);
    };
  }, []);

  // A Google sign-in landing on a device that already holds a legacy token
  // (a demo mailbox, a pre-migration login): fold that roster into the
  // signed-in user, so the person keeps their mailboxes without connecting
  // them again. The server spends the token on a successful adoption, so drop
  // it here too — this device signs in with a real identity now. A roster
  // that signs in on its own is refused; the person keeps using it through
  // the token and joins the two by connecting the mailbox.
  useEffect(() => {
    const legacy = mailStore.getState().authToken;
    if (!jwtAuthed || !legacy) return;
    void convexClient()
      .mutation(api.auth.adoptLegacySession, { token: legacy })
      .then((result) => {
        if (result.reason === "own-identity") {
          mailStore
            .getState()
            .pushToast("That mailbox has its own sign-in — connect it to join it here");
          return;
        }
        // Adopted, or the server does not know the token any more. Either way
        // it buys nothing now and keeping it only confuses the connect flow.
        mailStore.getState().setAuthToken(null);
      })
      .catch(() => {});
  }, [jwtAuthed]);

  // Dispatch binding + core subscriptions, re-wired per credential. `token`
  // is undefined for a pure Convex Auth session — the JWT rides the
  // websocket and the server resolves the caller from ctx.auth.
  useEffect(() => {
    const token = s.authToken ?? undefined;
    if (!token && !jwtAuthed) return;
    const c = convexClient();
    const owner = {};
    (mailStore.getState() as any)._setDispatch(
      (action: string, args: any, patches?: any, result?: any) =>
        c.mutation(api.dispatch.dispatch, { token, action, args, patches, result }),
      { owner },
    );

    const subs = [
      c.onUpdate(api.clusters.listClusters, { token }, rows => mailStore.getState().syncTable("clusters", rows)),
      c.onUpdate(api.filters.listFilters, { token }, rows => mailStore.getState().syncTable("filters", rows)),
      c.onUpdate(api.sync.getAccount, { token }, (payload) => {
        // Envelope: { account, accounts, client_state, outbound_pending }.
        const st = mailStore.getState();
        st.syncTable("accounts", payload.accounts ?? [payload.account]);
        st.pruneCalendarAccounts((payload.accounts ?? [payload.account]).map(account => account._id));
        if (payload.client_state) st.syncTable("clientState", payload.client_state);
        // The scoped account can disappear (revoked); fall back to unified.
        const cur = mailStore.getState();
        if (
          cur.accountScope !== "all" &&
          !(payload.accounts ?? [payload.account]).some(
            (a: { _id: string }) => a._id === cur.accountScope,
          )
        ) {
          cur.setAccountScope("all");
        }
      }),
      c.onUpdate(api.sync.listLabels, { token }, (labels) => {
        mailStore.getState().syncTable("labels", labels);
      }),
      c.onUpdate(api.memories.listMemories, { token }, (rows) => {
        mailStore.getState().syncTable("memories", rows);
      }),
      c.onUpdate(api.reminders.listReminders, { token }, (rows) => {
        mailStore.getState().syncTable("reminders", rows);
      }),
      c.onUpdate(api.sync.listThreads, { token, limit: 2000 }, (page) => {
        // The payload is { rows, nextSince, hasMore }. The first page lands
        // synchronously; when the server trimmed the page, follow nextSince —
        // never a row's own stamp — until the delta is drained.
        void drainDeltaPages(
          page,
          (since) => c.query(api.sync.listThreads, { token, since }),
          (rows) => mailStore.getState().syncTable("threads", rows),
        ).catch(() => {}); // A lost page re-arrives on the next server tick.
        // First sync with an empty cursor: land the cursor on the top row.
        const after = mailStore.getState();
        if (!after.focusedThreadId) {
          const top = Object.values(after.threads)
            .filter((t: any) => t.label_ids?.includes("INBOX"))
            .sort((a: any, b: any) => b.last_at - a.last_at)[0] as any;
          if (top) after.focusThread(top._id);
        }
      }),
    ];

    // Nudge a background refresh when the tab regains focus.
    const onFocus = () => {
      void c.mutation(api.sync.refresh, { token }).catch(() => {});
      (mailStore.getState() as any)._drainOutbox?.();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      for (const unsub of subs) unsub();
      window.removeEventListener("focus", onFocus);
      (mailStore.getState() as any)._clearDispatch(owner);
    };
  }, [s.authToken, jwtAuthed]);

  // Open-thread messages subscription. dep #2 of useTracked is the open
  // thread's gmail_id — read it from the store here (openThreadId is the row
  // _id, NOT the gmail id the query keys on).
  useEffect(() => {
    const st = mailStore.getState();
    const token = st.authToken ?? undefined;
    const open = st.openThreadId ? st.threads[st.openThreadId] : null;
    const gmailId = open?.gmail_id ?? null;
    if ((!token && !jwtAuthed) || !gmailId) return;
    const unsub = convexClient().onUpdate(
      api.sync.threadMessages,
      { token, threadGmailId: gmailId, accountId: open?.account_id as any },
      (messages) => {
        mailStore.getState().syncDetail("threadMessages", gmailId, messages);
      },
    );
    return unsub;
    // authToken in deps: a login/logout while a thread is open must rebind the
    // subscription (it was read from the store but not tracked).
  }, [s.openThreadId, s.authToken, jwtAuthed]);

  // Prefetch on dwell: once the cursor rests on a row for 150ms, subscribe to
  // its messages so Enter renders from cache in the same frame. The
  // subscription stays open briefly and detaches itself; the detail cache
  // keeps the payload.
  useEffect(() => {
    // Exactly one prefetch is live at a time. `cancel` tears down whatever the
    // current dwell created — its dwell timer, its close timer, and its
    // subscription — so a fast j/k stream can't leak or cross-cancel across
    // prefetches (the old shared `unsub` was overwritten without unsubscribing).
    let cancel: (() => void) | null = null;
    const stop = mailStore.subscribe((state, prev) => {
      if (state.focusedThreadId === prev.focusedThreadId) return;
      cancel?.();
      cancel = null;
      const token = state.authToken ?? undefined;
      const t = state.focusedThreadId ? state.threads[state.focusedThreadId] : null;
      if ((!token && !localAuth.hasStoredAuthToken()) || !t || state.openThreadId) return;
      const gmailId = t.gmail_id;
      if (state.threadMessages[gmailId]) return; // already cached

      let unsub: (() => void) | null = null;
      let closeTimer: ReturnType<typeof setTimeout> | null = null;
      const dwell = setTimeout(() => {
        unsub = convexClient().onUpdate(
          api.sync.threadMessages,
          { token, threadGmailId: gmailId, accountId: t.account_id as any },
          (messages) => {
            mailStore.getState().syncDetail("threadMessages", gmailId, messages);
          },
        );
        // One payload is all prefetch needs; the open-thread effect owns live
        // updates once the reader commits.
        closeTimer = setTimeout(() => {
          unsub?.();
          unsub = null;
        }, 4000);
      }, 150);
      cancel = () => {
        clearTimeout(dwell);
        if (closeTimer) clearTimeout(closeTimer);
        unsub?.();
      };
    });
    return () => {
      stop();
      cancel?.();
    };
  }, []);

  return null;
}
