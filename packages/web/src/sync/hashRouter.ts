import { useEffect } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { api } from "@mail/convex/convex/_generated/api";
import { mailStore } from "../store/mailStore";
import type { Thread, ViewId } from "../store/types";
import { convexClient } from "./ConvexSync";

// The store is the router; the URL hash is a projection of it (plus the one
// inbound moment: initial load / back-forward).
//
// `#t/<id>` is the thread link (`whisk link` prints it; notifications click
// through it). The id is a Gmail thread id, or a message id, which resolves
// to its thread. `#thread/<id>` is the older spelling and still opens.

export function threadHash(gmailId: string): string {
  return `#t/${encodeURIComponent(gmailId)}`;
}

function linkedThreadId(raw: string): string | null {
  const m = /^(?:t|thread)\/(.+)$/.exec(raw);
  return m ? m[1] : null;
}

const APP_TITLE = document.title;

// The tab reads as the thread when the thread is the page.
function stateToTitle(): string {
  const s = mailStore.getState();
  const t = s.openThreadId && s.openThreadId === s.soloThreadId ? s.threads[s.openThreadId] : null;
  return t ? `${t.subject || "(no subject)"} · Whisk` : APP_TITLE;
}

function stateToHash(): string {
  const s = mailStore.getState();
  if (s.openThreadId) {
    const t = s.threads[s.openThreadId];
    if (t) return threadHash(t.gmail_id);
  }
  if (s.activeView === "inbox") return "#inbox";
  return `#${encodeURIComponent(s.activeView)}`;
}

function localThread(gmailId: string): Thread | undefined {
  return Object.values(mailStore.getState().threads).find((t) => t.gmail_id === gmailId);
}

// The client can answer a lookup once it holds a credential: a legacy token
// in the store, or the Convex Auth JWT — which the provider hands over after
// reading storage, so the hook below tracks it the same way the sync
// subscriptions do rather than trusting storage alone.
let clientHoldsJwt = false;
function canReachServer(): boolean {
  return !!mailStore.getState().authToken || clientHoldsJwt;
}

function linkStillCurrent(gmailId: string): boolean {
  return linkedThreadId(decodeURIComponent(location.hash.slice(1))) === gmailId;
}

// A link to a thread the local projection does not hold (older than the
// synced window, another device's find, or a message id): one indexed read
// lands the row in the store, and the open-thread subscription does the rest.
let lookupInFlight: string | null = null;
async function openRemoteThread(gmailId: string): Promise<void> {
  if (!canReachServer() || lookupInFlight === gmailId) return;
  lookupInFlight = gmailId;
  try {
    const token = mailStore.getState().authToken ?? undefined;
    const rows = (await convexClient().query(api.sync.threadsByIds, { token, gmailIds: [gmailId] })) as Thread[];
    const row = rows[0];
    if (!row) {
      mailStore.getState().pushToast("That thread is not in any connected mailbox");
      return;
    }
    // A message id resolves to a thread that may already be cached.
    const cached = localThread(row.gmail_id);
    if (!cached) mailStore.getState().syncRecord("threads", row._id, row);
    if (linkStillCurrent(gmailId)) mailStore.getState().openThread(cached?._id ?? row._id, { solo: true });
  } catch {
    // Offline or unauthorized: the list is still there to read.
  } finally {
    lookupInFlight = null;
  }
}

let appliedInitial = false;
function tryInitialLink(): void {
  if (appliedInitial) return;
  const st = mailStore.getState();
  const linked = linkedThreadId(decodeURIComponent(location.hash.slice(1)));
  if (linked && !(st.hydrated && (localThread(linked) || canReachServer()))) return;
  appliedInitial = true;
  applyHash();
}

function applyHash(): void {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (!raw) return;
  const s = mailStore.getState();
  const gmailId = linkedThreadId(raw);
  if (gmailId) {
    // A link opens the thread as a page of its own: no rail, no list.
    const row = localThread(gmailId);
    if (row) s.openThread(row._id, { solo: true });
    else void openRemoteThread(gmailId);
    return;
  }
  const view = raw as ViewId;
  if (view !== s.activeView) s.setView(view);
  if (s.openThreadId) s.closeThread();
}

export function useHashRouter(): void {
  const jwtAuthed = useAuthToken() !== null;
  useEffect(() => {
    clientHoldsJwt = jwtAuthed;
    // A link that waited on sign-in resolves now.
    if (jwtAuthed) tryInitialLink();
  }, [jwtAuthed]);

  useEffect(() => {
    // Inbound: initial hash, then back/forward. A thread link waits for the
    // local cache (so it resolves locally when it can) and, failing that, for
    // a credential the lookup can use: a signed-out page keeps the link and
    // opens it right after sign-in.
    appliedInitial = false;

    tryInitialLink();
    const onHash = () => applyHash();
    window.addEventListener("hashchange", onHash);

    // Outbound: mirror store → hash without spamming history. Held until the
    // initial hash is applied — otherwise an early store change (pre-hydration,
    // openThreadId still null) would rewrite a `#t/…` deep link to `#inbox`
    // before applyHash ever gets to open it. A remote lookup keeps the link
    // in place the same way: the hash only follows the store once a thread
    // is open or the person navigates.
    const unsub = mailStore.subscribe(() => {
      tryInitialLink();
      if (!appliedInitial || lookupInFlight) return;
      const target = stateToHash();
      if (location.hash !== target) {
        history.replaceState(null, "", target);
      }
      const title = stateToTitle();
      if (document.title !== title) document.title = title;
    });
    return () => {
      window.removeEventListener("hashchange", onHash);
      unsub();
    };
  }, []);
}
