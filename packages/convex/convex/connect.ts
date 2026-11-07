import { v } from "convex/values";
import {
  httpAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  accountsForUser,
  createAuthSession,
  hashToken,
  loginRowsForUser,
  mintToken,
  requireUserId,
  requireViewerUserId,
  revokeOwnLogin,
  rowsForToken,
  touchSession,
} from "./lib/auth";
import {
  RETURN_CODE_PARAM,
  connectedApp,
  isAllowedReturnUrl,
  liveScopes,
  returnWith,
  scopeLabels,
  APP_REACH,
  type ConnectedApp,
} from "./lib/apps";

// Connecting another app to Whisk, so the app can read and act on the
// person's mail and calendar without ever holding a Google token.
//
//   1. The app sends the person to whisk.email/connect?app=<id>&return=<url>
//      &state=<s>. The page signs them in if needed (the same Google sign-in
//      Whisk always uses) and shows one screen naming the app and what it
//      may do (describe).
//   2. On Approve, `approve` stores a one-time code (hashed) and the page
//      sends the browser to the app's registered return URL with
//      ?whisk_code&state (RETURN_CODE_PARAM says why not `code`).
//   3. The app's SERVER posts the code and its secret to POST /apps/token
//      (exchange). The code is spent and an app token comes back: an
//      ordinary device login (lib/auth createAuthSession) stamped with the
//      app and its scopes. The app calls the same functions the `whisk` CLI
//      does, passing it as `token`; lib/auth lets it through only where the
//      function's scope is one the token holds.
//   4. The person sees the app in Settings and can revoke it; the app can end
//      its own connection with `disconnect`.

export { RETURN_CODE_PARAM };

/** How long a code from the connect screen may wait for its exchange. */
export const APP_CODE_TTL_MS = 5 * 60 * 1000;

function requireApp(appId: string, returnUrl: string): ConnectedApp {
  const app = connectedApp(appId);
  if (!app) throw new Error("Whisk does not know this app");
  if (!isAllowedReturnUrl(app, returnUrl)) {
    throw new Error(`This link does not return to ${app.name}`);
  }
  return app;
}

/** What the connect screen shows: the app, what it may do, and where Decline
 *  goes. Throws for an unknown app or a return URL it did not register, so
 *  the screen never offers to hand a code to a stranger. */
export const describe = query({
  args: { app_id: v.string(), return_url: v.string(), state: v.optional(v.string()) },
  handler: async (_ctx, { app_id, return_url, state }) => {
    const app = requireApp(app_id, return_url);
    return {
      app_id: app.id,
      name: app.name,
      blurb: app.blurb,
      scopes: scopeLabels(app.scopes),
      reach: APP_REACH,
      decline_url: returnWith(return_url, { error: "access_denied", state }),
    };
  },
});

/**
 * The person approved. Needs the signed-in person themselves (a Convex Auth
 * session or a full device login): an app token cannot approve another app.
 * Returns the URL to send the browser to, carrying the one-time code.
 */
export const approve = mutation({
  args: {
    token: v.optional(v.string()),
    app_id: v.string(),
    return_url: v.string(),
    state: v.optional(v.string()),
  },
  handler: async (ctx, { token, app_id, return_url, state }) => {
    const userId = await requireUserId(ctx, token);
    const app = requireApp(app_id, return_url);
    const code = mintToken();
    const now = Date.now();
    await ctx.db.insert("app_codes", {
      code_hash: await hashToken(code),
      user_id: userId,
      app_id: app.id,
      scopes: app.scopes,
      created_at: now,
      expires_at: now + APP_CODE_TTL_MS,
      ...(state ? { state_hash: await hashToken(state) } : {}),
    });
    return { redirect: returnWith(return_url, { [RETURN_CODE_PARAM]: code, state }) };
  },
});

type Redeemed =
  | { ok: true; token: string; user_id: string; email: string | null; scopes: string[]; connection_id: string }
  | { ok: false; error: "invalid_grant"; reason: "unknown" | "expired" | "reused" };

/**
 * Spend a code. Called only by the exchange route, after it checked the
 * app's secret. A code works once, for the app it was issued to, within its
 * time. A second redemption is a sign the code leaked, so it also revokes
 * the token the first one minted. The new token replaces any earlier
 * connection of the same app for this person: one row per app in Settings.
 */
export const redeem = internalMutation({
  args: { app_id: v.string(), code: v.string(), state: v.optional(v.string()) },
  handler: async (ctx, { app_id, code, state }): Promise<Redeemed> => {
    const app = connectedApp(app_id);
    const codeHash = await hashToken(code);
    const found = await ctx.db
      .query("app_codes")
      .withIndex("by_code_hash", (q) => q.eq("code_hash", codeHash))
      .unique();
    if (!app || !found || found.app_id !== app.id) {
      return { ok: false, error: "invalid_grant", reason: "unknown" };
    }
    // A code issued with a state is redeemable only with that state. The
    // app checks the state names its caller, so a leaked code cannot be
    // traded at the app for someone else. A mismatch spends nothing.
    if (found.state_hash !== undefined && (!state || (await hashToken(state)) !== found.state_hash)) {
      return { ok: false, error: "invalid_grant", reason: "unknown" };
    }
    const now = Date.now();
    if (found.redeemed_at !== undefined) {
      if (found.session_id && (await ctx.db.get(found.session_id))) {
        await ctx.db.delete(found.session_id);
      }
      return { ok: false, error: "invalid_grant", reason: "reused" };
    }
    if (found.expires_at <= now) {
      await ctx.db.delete(found._id);
      return { ok: false, error: "invalid_grant", reason: "expired" };
    }
    const user = await ctx.db.get(found.user_id);
    if (!user) {
      await ctx.db.delete(found._id);
      return { ok: false, error: "invalid_grant", reason: "unknown" };
    }

    for (const earlier of await loginRowsForUser(ctx, found.user_id, "app")) {
      if (earlier.app_id === app.id) await ctx.db.delete(earlier._id);
    }
    const scopes = liveScopes(app.id, found.scopes);
    const token = await createAuthSession(ctx, found.user_id, {
      device_name: app.name,
      app_id: app.id,
      scopes,
    });
    const minted = (await rowsForToken(ctx, token))[0];
    await ctx.db.patch(found._id, { redeemed_at: now, session_id: minted._id });

    const primary = (await accountsForUser(ctx, found.user_id))[0];
    return {
      ok: true,
      token,
      user_id: found.user_id,
      email: primary?.email ?? user.email ?? user.primary_email ?? null,
      scopes,
      connection_id: minted._id,
    };
  },
});

/** The person's connected apps, for Settings. */
export const list = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const userId = await requireViewerUserId(ctx, token);
    return (await loginRowsForUser(ctx, userId, "app"))
      .map((r) => {
        const app = connectedApp(r.app_id);
        return {
          _id: r._id,
          app_id: r.app_id!,
          name: app?.name ?? r.device_name ?? r.app_id!,
          scopes: scopeLabels(liveScopes(r.app_id!, r.scopes)),
          reach: APP_REACH,
          connected_at: r.created_at,
          last_used_at: r.last_seen_at,
        };
      });
  },
});

/** The person ends an app's access. Its token stops working at once. */
export const revoke = mutation({
  args: { token: v.optional(v.string()), connection_id: v.id("auth_sessions") },
  handler: async (ctx, { token, connection_id }) => {
    await revokeOwnLogin(ctx, token, connection_id, "app");
    return { revoked: true };
  },
});

/** The app ends its own connection (the person disconnected Whisk inside the
 *  app). Presenting the token is the proof; idempotent. */
export const disconnect = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    let disconnected = false;
    for (const row of await rowsForToken(ctx, token)) {
      if (!row.app_id) continue;
      await ctx.db.delete(row._id);
      disconnected = true;
    }
    return { disconnected };
  },
});

/** Spent and expired codes, cleared by the cron. */
export const pruneCodes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("app_codes")
      .withIndex("by_expires", (q) => q.lt("expires_at", Date.now()))
      .take(500);
    for (const row of stale) await ctx.db.delete(row._id);
    return { pruned: stale.length };
  },
});

/**
 * Record that a token was just used. Actions cannot write and queries cannot
 * either, so an action calls this after its access check passed; it is how
 * an app's "last used" in Settings moves on reads. Throttled in touchSession.
 */
export const touchToken = internalMutation({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    await touchSession(ctx, token);
  },
});

/**
 * Check a presented app secret against the deployment's env. Both sides are
 * hashed first so the comparison runs over equal lengths, and it never exits
 * early, so its time says nothing about how much of the secret matched. An
 * app with no secret configured matches nothing.
 */
export async function appSecretMatches(app: ConnectedApp, presented: string): Promise<boolean> {
  const expected = process.env[app.secretEnv];
  if (!expected || !presented) return false;
  const [a, b] = await Promise.all([hashToken(expected), hashToken(presented)]);
  // Equal lengths by construction (two sha256 hex digests), compared without
  // an early exit. @platform/crypto's timingSafeEqual is the shared home for
  // this once it is in a platform commit that Whisk's deploy builds against.
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return a.length === b.length && diff === 0;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * POST /apps/token — the server-to-server exchange. Body (JSON):
 * `{ app_id, app_secret, code, state }`, where `state` is the one the connect
 * link carried (required when the link had one). Answers `{ token, user_id, email, scopes,
 * connection_id }`, or an OAuth-style `{ error }`: `invalid_request` (400),
 * `invalid_client` (401, unknown app or wrong secret), `invalid_grant` (400,
 * a code that is unknown, expired, already spent, another app's, or sent
 * with a different state). The
 * secret is checked before the code is touched, so a caller without it
 * learns nothing about the code and cannot spend it.
 */
export const exchange = httpAction(async (ctx, request) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "invalid_request" });
  }
  const appId = typeof body.app_id === "string" ? body.app_id : "";
  const secret = typeof body.app_secret === "string" ? body.app_secret : "";
  const code = typeof body.code === "string" ? body.code : "";
  const state = typeof body.state === "string" && body.state ? body.state : undefined;
  if (!appId || !secret || !code) return json(400, { error: "invalid_request" });
  const app = connectedApp(appId);
  if (!app || !(await appSecretMatches(app, secret))) {
    return json(401, { error: "invalid_client" });
  }
  const result = await ctx.runMutation(internal.connect.redeem, { app_id: app.id, code, ...(state ? { state } : {}) });
  if (!result.ok) return json(400, { error: result.error });
  const { ok: _ok, ...grant } = result;
  return json(200, grant);
});
