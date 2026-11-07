import { v } from "convex/values";
import {
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import {
  attachAccountToSession,
  authUserId,
  createAuthSession,
  ensureUserForAccount,
  hashToken,
  mintToken,
} from "../lib/auth";
import { openCredential, openTokens, sealCredential, sealTokens } from "../lib/credentials";
import {
  exchangeCodeForTokens,
  fetchUserInfo,
  oauthConfig,
  requireOauthConfig,
} from "./api";

// The OAuth dance here is the mailbox CONNECTOR (gmail.modify), not sign-in —
// sign-in is Convex Auth (convex/auth.ts). For a signed-in caller it attaches
// the mailbox to their user via a single-use ticket and mints nothing. For an
// unauthenticated caller it is still one of exactly two places a legacy token
// is minted (the other is demo.seed), until cutover. It ends by handing the
// result to the opener window and closing.

// Mail plus the narrowest calendar pair that can read every calendar and
// write events on them: no calendar creation, no ACLs. `scopes` on the
// account row records what Google actually granted, because a person can
// untick a box on the consent screen and the app must never assume.
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  ...CALENDAR_SCOPES,
].join(" ");

/** Whether a granted-scope list covers the calendar. */
export function hasCalendarScope(scopes: readonly string[] | undefined): boolean {
  return CALENDAR_SCOPES.every((scope) => (scopes ?? []).includes(scope));
}

/**
 * Tell Google the grant is over. Revoking the refresh token invalidates the
 * whole grant (access tokens included). Best effort: the credentials rows are
 * already deleted by the time this runs, so a failure here leaves only a
 * token the user can still revoke from their Google account page.
 */
export const revokeToken = internalAction({
  args: { accountId: v.id("accounts"), sealed: v.string() },
  handler: async (_ctx, { accountId, sealed }) => {
    // A token that will not open still lets the disconnect finish: the
    // person can revoke the grant from their Google account page.
    const token = await openCredential(sealed, accountId, "refresh_token").catch(() => null);
    if (!token) return;
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
    } catch {
      // Nothing to retry against — the row holding the token is gone.
    }
  },
});

/**
 * A single-use attach credential for a signed-in Convex Auth caller. Their
 * JWT cannot ride through the OAuth state (Google and browser history see
 * it), and they hold no legacy token — so the connect popup carries this
 * ticket instead, through the exact attach path every legacy client uses.
 * The ticket is an auth_sessions row bound to the caller's user; its hash
 * travels in the state and completeConnect deletes it the moment the
 * mailbox lands. For a signed-in user every connect is an ATTACH: the
 * callback never mints a session token for them.
 */
export const mintAttachTicket = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await authUserId(ctx);
    if (!userId) throw new Error("Unauthorized: sign in first");
    const ticket = mintToken();
    const now = Date.now();
    await ctx.db.insert("auth_sessions", {
      user_id: userId,
      token_hash: await hashToken(ticket),
      created_at: now,
      last_seen_at: now,
      ticket: true,
    });
    return { ticket };
  },
});

function encodeState(payload: Record<string, string>): string {
  return btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeState(state: string | null): Record<string, string> {
  if (!state) return {};
  try {
    const base64 = state.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

// The token is a full-mailbox credential; it may only ever be postMessage'd to
// an origin we trust. The allowlist is the app's own web origins, configured
// out of band (never derived from the request). An unknown origin fails closed
// — we never fall back to "*", which would broadcast the token to any opener.
export function allowedOrigins(): string[] {
  const raw = process.env.OAUTH_ALLOWED_ORIGINS ?? "";
  const configured = raw
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  // localhost dev origins are always safe to accept — they can only be reached
  // from the developer's own machine.
  return [...configured, "http://localhost:3300", "http://127.0.0.1:3300"];
}

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  return allowedOrigins().includes(origin);
}

// A native app has no window.opener; it registers a custom scheme (e.g.
// mail://auth) in OAUTH_ALLOWED_ORIGINS and the callback 302-redirects there
// with the result in the URL fragment instead of a postMessage page. A web
// origin gets the same delivery when it started the flow with mode=redirect
// (same-tab sign-in, no popup).
function isNativeOrigin(origin: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//.test(origin) && !/^https?:\/\//.test(origin);
}

function fragmentRedirect(
  origin: string,
  fragment: Record<string, string>,
): Response {
  const params = new URLSearchParams(fragment);
  return new Response(null, {
    status: 302,
    headers: { Location: `${origin}#${params.toString()}` },
  });
}

// HTML-escape untrusted text before it enters markup. The error string is
// attacker-controllable (?error= on the callback), so reflecting it raw is XSS
// on the token-minting origin.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** GET /gmail/auth — redirect the popup (or, with mode=redirect, the tab
 *  itself) to Google's consent screen. */
export const authStart = httpAction(async (_ctx, request) => {
  const config = oauthConfig();
  if (!config.clientId || !config.redirectUrl) {
    return new Response(
      "Gmail OAuth is not configured on this deployment. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and OAUTH_REDIRECT_URL.",
      { status: 503, headers: { "Content-Type": "text/plain" } },
    );
  }
  // The app tells us where to deliver the token, and we post it back to that
  // exact origin. Reject an untrusted origin before starting the flow — the
  // token must never be minted for a destination we won't post it to.
  const search = new URL(request.url).searchParams;
  const origin = search.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) {
    return new Response(
      "This origin is not allowed to connect Gmail. Configure OAUTH_ALLOWED_ORIGINS on the deployment.",
      { status: 403, headers: { "Content-Type": "text/plain" } },
    );
  }
  // Adding a second account to a signed-in session: the client passes its
  // token, and only its HASH rides through the state (Google and browser
  // history see state, never a usable credential). select_account forces the
  // chooser so the user can pick a different mailbox than the one signed in.
  const attach = search.get("attach") ?? "";
  const state: Record<string, string> = { origin };
  if (attach) state.attach = await hashToken(attach);
  // Same-tab sign-in: the callback lands back on the origin with the result
  // in the URL fragment instead of posting to a popup opener.
  if (search.get("mode") === "redirect") state.redirect = "1";
  // Reconnecting a known mailbox: preselect it on Google's chooser so the
  // person cannot grant the wrong account by accident.
  const hint = search.get("hint") ?? "";
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUrl,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: attach ? "consent select_account" : "consent",
    include_granted_scopes: "true",
    state: encodeState(state),
    ...(hint ? { login_hint: hint } : {}),
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    },
  });
});

function escapeForScript(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Deliver the OAuth result to the app that started the flow. Exported for
 *  tests only. */
export function closingPage(body: {
  token?: string;
  attached?: boolean;
  error?: string;
  origin: string;
  redirect?: boolean;
}): Response {
  // Fail closed: only deliver to a trusted origin, and never to "*". An
  // untrusted origin gets a token-free page — the credential is not posted.
  const trusted = isAllowedOrigin(body.origin);
  // Native app or same-tab web flow: deliver through the URL fragment, not
  // postMessage — there is no opener to post to.
  if (trusted && (isNativeOrigin(body.origin) || body.redirect)) {
    if (body.token) return fragmentRedirect(body.origin, { token: body.token });
    if (body.attached) return fragmentRedirect(body.origin, { attached: "1" });
    return fragmentRedirect(body.origin, {
      error: body.error ?? "unknown error",
    });
  }
  const token = trusted ? body.token : undefined;
  // An attach posts no token — the opener already holds it; the message is
  // just "your session grew an account".
  const attached = trusted && !!body.attached;
  const errorText = trusted
    ? body.error ?? "unknown error"
    : "This app origin is not allowed to receive a sign-in.";
  const payload = token
    ? `{ type: "mail-auth", token: ${escapeForScript(token)} }`
    : attached
      ? `{ type: "mail-auth-attached" }`
      : `{ type: "mail-auth-error", error: ${escapeForScript(errorText)} }`;
  // Only emit the postMessage call at all when we have a trusted target; the
  // targetOrigin is the validated origin, never "*".
  const post = trusted
    ? `try { window.opener && window.opener.postMessage(${payload}, ${escapeForScript(body.origin)}); } catch (e) {}`
    : "";
  const html = `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${token || attached ? "Connected" : "Connection failed"}</title>
<style>
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; background: #faf7f2;
         color: #1b1917; display: grid; place-items: center; height: 100vh; margin: 0; }
  p { max-width: 34ch; text-align: center; }
</style>
<p>${token || attached ? "Mailbox connected. You can close this window." : `Could not connect: ${escapeHtml(errorText)}`}</p>
<script>
  ${post}
  setTimeout(function () { window.close(); }, ${token || attached ? 300 : 4000});
</script>`;
  return new Response(html, {
    status: token || attached ? 200 : 400,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    },
  });
}

/** GET /gmail/oauth/callback — exchange the code and hand back a token. */
export const oauthCallback = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const state = decodeState(url.searchParams.get("state"));
  const origin = state.origin ?? "";
  const redirect = state.redirect === "1";
  const error = url.searchParams.get("error");
  if (error) return closingPage({ error, origin, redirect });

  const code = url.searchParams.get("code");
  if (!code) return closingPage({ error: "missing code", origin, redirect });

  try {
    requireOauthConfig();
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // Without offline access there is nothing to sync with tomorrow.
      return closingPage({
        error: "Google did not return a refresh token — revoke access and retry",
        origin,
        redirect,
      });
    }
    const profile = await fetchUserInfo(tokens.access_token);
    const { token, attached, accountId } = await ctx.runMutation(
      internal.gmail.oauth.completeConnect,
      {
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry: Date.now() + tokens.expires_in * 1000,
        scopes: (tokens.scope ?? "").split(/\s+/).filter(Boolean),
        attach_hash: state.attach || undefined,
      },
    );
    await ctx.scheduler.runAfter(0, internal.gmail.sync.backfill, { accountId });
    await ctx.scheduler.runAfter(0, internal.gmail.watch.watchAccount, { accountId });
    await ctx.scheduler.runAfter(0, internal.calendar.sync.syncAccount, {
      accountId,
    });
    return closingPage({ token, attached, origin, redirect });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return closingPage({ error: message, origin, redirect });
  }
});

export const completeConnect = internalMutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
    picture: v.optional(v.string()),
    access_token: v.string(),
    refresh_token: v.string(),
    expiry: v.number(),
    scopes: v.optional(v.array(v.string())),
    // Present when this connect ATTACHES to an existing session (the hash of
    // its token) instead of minting a new one.
    attach_hash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();

    let accountId: Id<"accounts">;
    if (existing) {
      accountId = existing._id;
      await ctx.db.patch(existing._id, {
        name: args.name,
        picture: args.picture,
        provider: "gmail" as const,
        // Reconnecting is a fresh start for the sync state machine; a stale
        // history cursor would otherwise 404 on the first incremental pass.
        sync_status: "backfilling" as const,
        sync_error: undefined,
        scopes: args.scopes,
        // A reconnect that gains (or loses) the calendar starts its mirror
        // clean: the incremental cursors belong to the old grant.
        calendar_error: undefined,
        updated_at: now,
      });
    } else {
      accountId = await ctx.db.insert("accounts", {
        email: args.email,
        name: args.name,
        picture: args.picture,
        provider: "gmail" as const,
        sync_status: "backfilling" as const,
        scopes: args.scopes,
        updated_at: now,
      });
    }

    const credentials = await ctx.db
      .query("credentials")
      .withIndex("by_account", (q) => q.eq("account_id", accountId))
      .unique();
    const sealed = await sealTokens(accountId, args);
    if (credentials) {
      await ctx.db.patch(credentials._id, { ...sealed, expiry: args.expiry });
    } else {
      await ctx.db.insert("credentials", {
        account_id: accountId,
        ...sealed,
        expiry: args.expiry,
      });
    }

    // Resolve the owner. Signing in with an address that already belongs to
    // a user recovers that user's WHOLE roster on this device — this is what
    // makes any connected Gmail the login for everything.
    const accountRow = (await ctx.db.get(accountId))!;
    const userId = await ensureUserForAccount(ctx, accountRow);

    if (args.attach_hash) {
      const ok = await attachAccountToSession(ctx, args.attach_hash, accountId);
      if (!ok) {
        // The session the popup was opened from no longer exists (signed out
        // mid-flow). Fall back to a fresh login so the connect still lands.
        const token = await createAuthSession(ctx, userId);
        return { token, attached: false, accountId };
      }
      // A ticket is single-use: minted only to carry this connect, deleted
      // the moment the mailbox lands. Real device logins have no `ticket`
      // flag and survive.
      for (const row of await ctx.db
        .query("auth_sessions")
        .withIndex("by_token_hash", (q) => q.eq("token_hash", args.attach_hash!))
        .collect()) {
        if (row.ticket) await ctx.db.delete(row._id);
      }
      return { token: undefined, attached: true, accountId };
    }

    const token = await createAuthSession(ctx, userId);
    return { token, attached: false, accountId };
  },
});

/** Internal only — credentials never leave the backend. */
export const credentialsFor = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const row = await ctx.db
      .query("credentials")
      .withIndex("by_account", (q) => q.eq("account_id", accountId))
      .unique();
    if (!row) return null;
    return { ...(await openTokens(accountId, row)), expiry: row.expiry };
  },
});

export const storeCredentials = internalMutation({
  args: {
    accountId: v.id("accounts"),
    access_token: v.string(),
    refresh_token: v.optional(v.string()),
    expiry: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("credentials")
      .withIndex("by_account", (q) => q.eq("account_id", args.accountId))
      .unique();
    if (!row) throw new Error("No credentials row to update");
    await ctx.db.patch(row._id, {
      access_token: await sealCredential(args.access_token, args.accountId, "access_token"),
      // A refresh response omits refresh_token; keep the one we have (sealing
      // it in the bound form too if the migration has not reached this row).
      refresh_token: await sealCredential(args.refresh_token ?? row.refresh_token, args.accountId, "refresh_token"),
      expiry: args.expiry,
    });
  },
});

// A backfill/incremental that crashed leaves the account pinned in its
// in-progress status. After this long with no progress, treat it as wedged and
// let the cron restart it — otherwise a crashed backfill never syncs again.
const SYNC_WEDGED_MS = 10 * 60 * 1000;

export const accountsToSync = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<Doc<"accounts">["_id"]>> => {
    const rows = await ctx.db.query("accounts").collect();
    const now = Date.now();
    return rows
      .filter((a) => {
        if (a.provider !== "gmail") return false;
        // Skip an account whose sync is actively in progress (fresh
        // updated_at) — prevents overlapping incrementals and duplicate
        // backfills. A stale in-progress status is wedged: sync it to recover.
        if (a.sync_status === "backfilling" || a.sync_status === "syncing") {
          return now - a.updated_at > SYNC_WEDGED_MS;
        }
        return true;
      })
      .map((a) => a._id);
  },
});
