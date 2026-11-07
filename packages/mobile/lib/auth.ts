import * as WebBrowser from "expo-web-browser";
import { api } from "@mail/convex/convex/_generated/api";
import { mailStore } from "@mail/shared/src/store/mailStore";
import { convexClient } from "./convex";
import { CONVEX_SITE_URL } from "./convex";
import { forgetPush } from "./push";

export async function seedDemo(): Promise<void> {
  const { token } = await convexClient().mutation(api.demo.seed, {});
  mailStore.getState().setAuthToken(token);
}

/** Attach ANOTHER demo mailbox to the current session — the demo's version of
 *  multi-account. The live accounts subscription picks it up. */
export async function attachDemoMailbox(): Promise<void> {
  const attach_token = mailStore.getState().authToken;
  if (!attach_token) return seedDemo();
  await convexClient().mutation(api.demo.seed, { attach_token });
}

// The native scheme is the "origin" the backend allowlists and redirects to:
// the callback 302s to tersemail://auth#token=… (contract with gmail/oauth.ts).
const NATIVE_ORIGIN = "tersemail://auth";

/** Open the Gmail consent flow. With a session already signed in, the new
 *  mailbox ATTACHES to it (multi-account) instead of replacing it — the
 *  callback answers #attached=1 and the live accounts subscription picks the
 *  new account up. */
export async function connectGmail(hint?: string): Promise<{ ok: boolean; error?: string }> {
  let authUrl = `${CONVEX_SITE_URL}/gmail/auth?origin=${encodeURIComponent(NATIVE_ORIGIN)}`;
  const existing = mailStore.getState().authToken;
  if (existing) authUrl += `&attach=${encodeURIComponent(existing)}`;
  // A reconnect names the mailbox so Google preselects it.
  if (hint) authUrl += `&hint=${encodeURIComponent(hint)}`;
  const result = await WebBrowser.openAuthSessionAsync(authUrl, NATIVE_ORIGIN);
  if (result.type !== "success" || !result.url) {
    return { ok: false, error: result.type === "cancel" ? undefined : "Sign-in was interrupted" };
  }
  const fragment = result.url.split("#")[1] ?? "";
  const params = new URLSearchParams(fragment);
  const token = params.get("token");
  const error = params.get("error");
  if (token) {
    mailStore.getState().setAuthToken(token);
    return { ok: true };
  }
  if (params.get("attached")) return { ok: true }; // account joined the existing session
  return { ok: false, error: error ?? "No token returned" };
}

export function signOut(): void {
  const token = mailStore.getState().authToken;
  if (token) void forgetPush(token);
  mailStore.getState().setAuthToken(null);
}

/** Ask the server for an incremental pass on every connected mailbox now,
 *  instead of waiting for the two minute cron. */
export function refreshSync(): Promise<unknown> {
  const token = mailStore.getState().authToken;
  if (!token) return Promise.resolve();
  return convexClient()
    .mutation(api.sync.refresh, { token })
    .catch(() => {});
}

/**
 * Disconnect an account: the server revokes the Google grant and deletes the
 * mirrored mailbox. When it was the last account the session is over — sign
 * this device out.
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
    signOut();
    return;
  }
  mailStore.getState().pushToast("Account disconnected — synced data deleted");
}
