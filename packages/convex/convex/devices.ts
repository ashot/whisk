import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import {
  createAuthSession,
  hashToken,
  loginRowsForUser,
  requireUserId,
  requireViewerUserId,
  revokeOwnLogin,
} from "./lib/auth";

// Device logins for terminals and agents. A device token is an ordinary
// auth_sessions row — the same credential the web app used before Convex
// Auth — so every query and mutation that takes `token` already accepts it.
// Minting needs a caller who is signed in (Convex Auth JWT or a legacy
// token); revoking deletes the row, which ends that device's access at once.

export const mint = mutation({
  args: {
    // A legacy-token web session presents its token; a Convex Auth session
    // sends none and resolves from ctx.auth.
    token: v.optional(v.string()),
    device_name: v.string(),
  },
  handler: async (ctx, { token, device_name }) => {
    const userId = await requireUserId(ctx, token);
    const minted = await createAuthSession(ctx, userId, {
      device_name: device_name.slice(0, 120),
    });
    const user = await ctx.db.get(userId);
    return {
      token: minted,
      user_id: userId,
      email: user?.email ?? user?.primary_email ?? null,
    };
  },
});

/**
 * Every device login the caller's user holds. The caller's own row (when it
 * presented a token) is flagged so a CLI can say "this one is you".
 */
export const list = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const userId = await requireViewerUserId(ctx, token);
    const mine = token ? await hashToken(token) : null;
    // Connected apps have their own list and revoke (connect.ts).
    return (await loginRowsForUser(ctx, userId, "device"))
      .map((r) => ({
        _id: r._id,
        device_name: r.device_name ?? null,
        created_at: r.created_at,
        last_seen_at: r.last_seen_at,
        current: mine !== null && r.token_hash === mine,
      }));
  },
});

export const revoke = mutation({
  args: { token: v.optional(v.string()), session_id: v.id("auth_sessions") },
  handler: async (ctx, { token, session_id }) => {
    await revokeOwnLogin(ctx, token, session_id, "device");
    return { revoked: true };
  },
});

/**
 * Bootstrap for the deployment's owner: mint a device token for the user
 * who owns `email`, from the Convex CLI (`npx convex run devices:mintForEmail`).
 * Internal only — reachable with deploy credentials, never from the wire.
 */
export const mintForEmail = internalMutation({
  args: { email: v.string(), device_name: v.string() },
  handler: async (ctx, { email, device_name }) => {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_email", (q) => q.eq("email", email.toLowerCase().trim()))
      .unique();
    if (!account?.user_id) throw new Error(`No connected account for ${email}`);
    const minted = await createAuthSession(ctx, account.user_id, { device_name });
    return { token: minted, user_id: account.user_id, email: account.email };
  },
});

// Push registration for the phone app. The token is Expo's push token for
// this install; it belongs to the signed-in user, so mail in any of their
// mailboxes can reach this phone.
export const registerPush = mutation({
  args: {
    token: v.optional(v.string()),
    push_token: v.string(),
    platform: v.union(v.literal("ios"), v.literal("android")),
    time_zone: v.optional(v.string()),
  },
  handler: async (ctx, { token, push_token, platform, time_zone }) => {
    const userId = await requireUserId(ctx, token);
    const now = Date.now();
    const existing = await ctx.db
      .query("push_devices")
      .withIndex("by_token", (q) => q.eq("push_token", push_token))
      .unique();
    if (existing) {
      // A phone that changed hands (sign out, sign in as someone else) moves
      // to its new owner rather than pushing the old one's mail.
      await ctx.db.patch(existing._id, { user_id: userId, platform, time_zone, updated_at: now });
      return { registered: true };
    }
    await ctx.db.insert("push_devices", { user_id: userId, push_token, platform, time_zone, created_at: now, updated_at: now });
    return { registered: true };
  },
});

/** The phones registered for this user — so the settings screen can say
 *  whether this install actually handed a token over. */
export const myPush = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const userId = await requireViewerUserId(ctx, token);
    const rows = await ctx.db
      .query("push_devices")
      .withIndex("by_user", (q) => q.eq("user_id", userId))
      .collect();
    return rows.map((r) => ({
      platform: r.platform,
      updated_at: r.updated_at,
      current: token ? r.push_token.length > 0 : false,
    }));
  },
});

/** Sign out on the phone: stop pushing to it. Idempotent. */
export const unregisterPush = mutation({
  args: { token: v.optional(v.string()), push_token: v.string() },
  handler: async (ctx, { token, push_token }) => {
    const userId = await requireUserId(ctx, token);
    const existing = await ctx.db
      .query("push_devices")
      .withIndex("by_token", (q) => q.eq("push_token", push_token))
      .unique();
    if (existing && existing.user_id === userId) await ctx.db.delete(existing._id);
    return { unregistered: true };
  },
});
