import { getAuthUserId } from "@convex-dev/auth/server";
import { createLocalJWKSet, jwtVerify } from "jose";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { appRowAllows, rowIsLimited, type ScopeNeed } from "./apps";

// Every public query and mutation resolves its caller through this module.
// Two credentials exist during the migration to Convex Auth (ct-44709):
//   1. A Convex Auth identity (ctx.auth, from the Google sign-in JWT) — the
//      preferred path, resolved first wherever a ctx carries it.
//   2. A legacy opaque token: a random 32-byte string handed to exactly one
//      client; only its sha256 digest is stored, so a database read never
//      yields a usable token. Still minted by demo.seed (the zero-signup
//      demo) and by the unauthenticated Gmail connect, until cutover.
//
// A device token for a terminal (devices.mint) is the same opaque token. So
// is an app token (connect.ts): its row also names the connected app and the
// scopes the person granted it. Every resolver below takes the scope the
// calling function needs. An app token resolves only when its row holds that
// scope; a function that names no scope never resolves an app token. That one
// rule, in sessionsForToken, is the whole scope check.

const TOKEN_BYTES = 32;

/** Read side of a Convex ctx — the part requireAccount needs. `auth` is
 *  present on real function ctxs and absent in a few pure-db call sites. */
export type ReadCtx = { db: QueryCtx["db"]; auth?: QueryCtx["auth"] };

/** Write side, for the places that mint tokens and merge users. */
export type WriteCtx = { db: MutationCtx["db"]; auth?: MutationCtx["auth"] };

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh opaque token. Returned to the client once and never stored raw. */
export function mintToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** sha256 as lowercase hex, via Web Crypto (present in the Convex runtime). */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** What a login row may carry besides its owner: a terminal's name, or a
 *  connected app and its scopes (connect.ts). */
export type LoginFields = Pick<Doc<"auth_sessions">, "device_name" | "app_id" | "scopes" | "hides_private">;

/**
 * Create a login for a USER and return the raw token. The browser sign-in
 * (`demo.seed`, the Gmail OAuth callback), a terminal (devices.mint) and a
 * connected app (connect.redeem) all mint here. A login without `app_id`
 * yields the user's whole account roster; an app login only what its scopes
 * allow.
 */
export async function createAuthSession(
  ctx: WriteCtx,
  userId: Id<"users">,
  fields: Partial<LoginFields> = {},
): Promise<string> {
  const token = mintToken();
  const now = Date.now();
  await ctx.db.insert("auth_sessions", {
    user_id: userId,
    token_hash: await hashToken(token),
    created_at: now,
    last_seen_at: now,
    ...fields,
  });
  return token;
}

/**
 * The Convex Auth caller, or null. Null when the ctx carries no auth (pure
 * db call sites), when nobody is signed in, or when the identity names a
 * user row that no longer exists (a stale JWT must not resolve to access).
 */
export async function authUserId(ctx: ReadCtx): Promise<Id<"users"> | null> {
  if (!ctx.auth) return null;
  const userId = (await getAuthUserId(ctx as any)) as Id<"users"> | null;
  if (!userId) return null;
  return (await ctx.db.get(userId)) ? userId : null;
}

/**
 * Resolve a Convex Auth access JWT presented OUTSIDE the normal transport —
 * the attachment URL's query string, where an <img> tag cannot send an
 * Authorization header. Verified against the deployment's own JWKS (the env
 * var Convex Auth setup writes), issuer and audience included: a parse
 * without verification would mint access from any well-formed token.
 * Returns null for legacy opaque tokens (no dots) and anything invalid.
 */
export async function userIdFromAuthJwt(
  token: string,
): Promise<Id<"users"> | null> {
  if (!token.includes(".")) return null;
  const jwks = process.env.JWKS;
  if (!jwks) return null;
  try {
    const { payload } = await jwtVerify(
      token,
      createLocalJWKSet(JSON.parse(jwks)),
      { audience: "convex", issuer: process.env.CONVEX_SITE_URL },
    );
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    // Convex Auth subjects are "<userId>|<sessionId>".
    const userId = subject.split("|")[0];
    return userId ? (userId as Id<"users">) : null;
  } catch {
    return null;
  }
}

/**
 * The user an account belongs to, creating one on first touch. Every account
 * has exactly one owner; this is the only place a user row is born.
 */
export async function ensureUserForAccount(
  ctx: WriteCtx,
  account: Doc<"accounts">,
): Promise<Id<"users">> {
  if (account.user_id) return account.user_id;
  const now = Date.now();
  const userId = await ctx.db.insert("users", {
    primary_email: account.email,
    // Stamped so a later Google sign-in with this address dedupes onto this
    // user through Convex Auth's email index instead of forking a new one.
    email: account.email.toLowerCase().trim(),
    created_at: now,
    updated_at: now,
  });
  await ctx.db.patch(account._id, { user_id: userId, updated_at: now });
  return userId;
}

/** Every account a user owns, in connect order. */
export async function accountsForUser(
  ctx: ReadCtx,
  userId: Id<"users">,
): Promise<Doc<"accounts">[]> {
  const rows = await ctx.db
    .query("accounts")
    .withIndex("by_user", (q) => q.eq("user_id", userId))
    .collect();
  return rows.sort((a, b) => a._creationTime - b._creationTime);
}

/**
 * True when a user can sign in on its own — it holds a Convex Auth identity
 * (the row a Google sign-in writes) or a live Convex Auth session. Such a
 * user is somebody's whole account, not an unclaimed roster.
 */
export async function hasAuthIdentity(
  ctx: ReadCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const account = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .first();
  if (account) return true;
  const session = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .first();
  return session !== null;
}

/**
 * Fold user `loser` into user `winner`: accounts, device logins, and prefs
 * move over, then the loser row is deleted. Runs when a connect proves two
 * rosters belong to one person (they signed in with an account the other
 * user already owns).
 *
 * A merge never touches Convex Auth's own tables, and refuses outright when
 * the loser holds a row in them. Every path into a merge is authorized, on
 * at least one side, by a legacy token — a bearer string. A token is meant
 * to be revocable: its owner deletes the session row and the access ends.
 * Moving an authAccounts row would turn that string into something
 * permanent, because the row is what a future Google sign-in resolves
 * through: whoever ended up holding it would keep signing in to the merged
 * roster long after the token was revoked. So a user that can sign in on its
 * own is never merged away. The person can connect the mailbox from that
 * account instead, where a live Google consent screen carries the proof.
 */
export async function mergeUsers(
  ctx: WriteCtx,
  winnerId: Id<"users">,
  loserId: Id<"users">,
): Promise<void> {
  if (winnerId === loserId) return;
  if (await hasAuthIdentity(ctx, loserId)) {
    throw new Error("Cannot merge: that account signs in on its own");
  }
  const now = Date.now();
  for (const account of await ctx.db
    .query("accounts")
    .withIndex("by_user", (q) => q.eq("user_id", loserId))
    .collect()) {
    await ctx.db.patch(account._id, { user_id: winnerId, updated_at: now });
  }
  for (const session of await ctx.db
    .query("auth_sessions")
    .withIndex("by_user", (q) => q.eq("user_id", loserId))
    .collect()) {
    await ctx.db.patch(session._id, { user_id: winnerId });
  }
  // Convex Auth's own rows stay where they are — see the note above. The
  // loser was checked to hold none, so the winner's identity is the only one
  // left and it keeps signing in to the merged roster.

  // Prefs: the winner's row stands; a loser-only row transfers.
  const winnerState = await ctx.db
    .query("client_state")
    .withIndex("by_user", (q) => q.eq("user_id", winnerId))
    .unique();
  for (const state of await ctx.db
    .query("client_state")
    .withIndex("by_user", (q) => q.eq("user_id", loserId))
    .collect()) {
    if (winnerState) await ctx.db.delete(state._id);
    else await ctx.db.patch(state._id, { user_id: winnerId, updated_at: now });
  }
  await ctx.db.delete(loserId);
}

/**
 * Resolve a caller to ONE account, or throw. With `accountId`, that account —
 * verified to belong to this caller. Without, the caller's first (primary)
 * account, which keeps every single-account caller working unchanged.
 * Read-only so queries can use it; `last_seen_at` is bumped by `touchSession`
 * on the mutation path.
 */
export async function requireAccount(
  ctx: ReadCtx,
  token: string | undefined,
  accountId?: Id<"accounts">,
  scope?: ScopeNeed,
): Promise<Doc<"accounts">> {
  const accounts = await requireAccounts(ctx, token, scope);
  if (accounts.length === 0) {
    // Only reachable on the Convex Auth path: signed in, nothing connected.
    throw new Error("Unauthorized: no connected accounts");
  }
  if (accountId === undefined) return accounts[0];
  const match = accounts.find((a) => a._id === accountId);
  if (!match) throw new Error("Unauthorized: account not in this session");
  return match;
}

/**
 * Every account this caller can read, in connect order.
 *
 * A Convex Auth identity resolves first and needs no token; its roster may
 * be EMPTY — signed in, nothing connected yet, a real onboarding state (with
 * a legacy token also presented, that token's roster answers instead, so a
 * demo mailbox survives the Google sign-in until adoptLegacySession merges).
 *
 * The legacy token path is unchanged: the token names a device login; the
 * login names a USER; the roster is the user's accounts — so every device of
 * one user sees the same set, and a token can never reach an account its
 * user does not own. Pre-migration rows (account_id, no user_id) resolve to
 * their listed accounts until the backfill stamps them.
 */
export async function requireAccounts(
  ctx: ReadCtx,
  token?: string,
  scope?: ScopeNeed,
): Promise<Doc<"accounts">[]> {
  return (await resolveCaller(ctx, token, scope)).accounts;
}

/**
 * The caller's accounts (as requireAccounts) and whether the caller is kept
 * from private mail: a connected app or a terminal login for agents. The
 * person's own sessions (Convex Auth, a full terminal) are not. lib/privacy
 * builds every read and write gate on this.
 */
export async function resolveCaller(
  ctx: ReadCtx,
  token?: string,
  scope?: ScopeNeed,
): Promise<{ accounts: Doc<"accounts">[]; hidesPrivate: boolean }> {
  const callerId = await authUserId(ctx);
  if (callerId) {
    const owned = await accountsForUser(ctx, callerId);
    if (owned.length > 0 || !token) return { accounts: owned, hidesPrivate: false };
  }
  if (!token) throw new Error("Unauthorized: missing token");
  const sessions = await sessionsForToken(ctx, token, scope);
  if (sessions.length === 0) throw new Error("Unauthorized: unknown token");
  const hidesPrivate = sessions.some(rowIsLimited);

  const userId = sessions.find((s) => s.user_id)?.user_id;
  if (userId) {
    const accounts = await accountsForUser(ctx, userId);
    if (accounts.length === 0) {
      throw new Error("Unauthorized: account no longer exists");
    }
    return { accounts, hidesPrivate };
  }

  // Legacy session rows: one per account, no user stamped yet.
  const accounts: Doc<"accounts">[] = [];
  for (const session of sessions) {
    const account = session.account_id
      ? await ctx.db.get(session.account_id)
      : null;
    if (account) accounts.push(account);
  }
  if (accounts.length === 0) {
    throw new Error("Unauthorized: account no longer exists");
  }
  return { accounts, hidesPrivate };
}

/** The user a token belongs to, or null for un-migrated legacy sessions. */
export async function userForToken(
  ctx: ReadCtx,
  token: string,
  scope?: ScopeNeed,
): Promise<Id<"users"> | null> {
  const sessions = await sessionsForToken(ctx, token, scope);
  return sessions.find((s) => s.user_id)?.user_id ?? null;
}

/**
 * The person looking, for read paths that key on the user (lists in
 * Settings, the push check). Convex Auth identity first; else the user behind
 * a device token. An app token names no scope here, so it resolves nothing:
 * an app cannot read the person's own bookkeeping. Null when nobody is
 * signed in; a query cannot upgrade legacy rows the way requireUserId does.
 */
export async function viewerUserId(
  ctx: ReadCtx,
  token?: string,
): Promise<Id<"users"> | null> {
  return (await authUserId(ctx)) ?? (token ? await userForToken(ctx, token) : null);
}

/** viewerUserId, refusing when nobody is signed in. */
export async function requireViewerUserId(
  ctx: ReadCtx,
  token?: string,
): Promise<Id<"users">> {
  const userId = await viewerUserId(ctx, token);
  if (!userId) throw new Error("Unauthorized: missing token");
  return userId;
}

/** A login row is a device (a browser, a phone, a terminal) or a connected
 *  app. Each has its own list and revoke; neither reaches the other's rows. */
export type LoginKind = "device" | "app";

function loginKindOf(row: Doc<"auth_sessions">): LoginKind {
  return row.app_id ? "app" : "device";
}

/** The person's logins of one kind, oldest first. Attach tickets are connect
 *  credentials, never logins, and are left out. */
export async function loginRowsForUser(
  ctx: ReadCtx,
  userId: Id<"users">,
  kind: LoginKind,
): Promise<Doc<"auth_sessions">[]> {
  const rows = await ctx.db
    .query("auth_sessions")
    .withIndex("by_user", (q) => q.eq("user_id", userId))
    .collect();
  return rows
    .filter((r) => !r.ticket && loginKindOf(r) === kind)
    .sort((a, b) => a.created_at - b.created_at);
}

/** The signed-in person ends one of their own logins of `kind`. A row of
 *  another person or the other kind is refused as not found. */
export async function revokeOwnLogin(
  ctx: WriteCtx,
  token: string | undefined,
  id: Id<"auth_sessions">,
  kind: LoginKind,
): Promise<void> {
  const userId = await requireUserId(ctx, token);
  const row = await ctx.db.get(id);
  if (!row || row.ticket || row.user_id !== userId || loginKindOf(row) !== kind) {
    throw new Error(kind === "app" ? "Connection not found" : "Device not found");
  }
  await ctx.db.delete(row._id);
}

/** How long an attach ticket may sit unused before the connect must fail. */
export const ATTACH_TICKET_TTL_MS = 10 * 60 * 1000;

/**
 * The login rows behind a token. `scope` is what the calling function needs:
 * an app token's row is returned only when it holds that scope, and never
 * when the caller names none.
 */
export async function sessionsForToken(
  ctx: ReadCtx,
  token: string,
  scope?: ScopeNeed,
): Promise<Doc<"auth_sessions">[]> {
  return (await rowsForToken(ctx, token)).filter((r) => appRowAllows(r, scope));
}

/** Every non-ticket row behind a token, app rows included, before any scope
 *  check. Bookkeeping and an app's own disconnect read this; access never. */
export async function rowsForToken(
  ctx: ReadCtx,
  token: string,
): Promise<Doc<"auth_sessions">[]> {
  if (!token) return [];
  const tokenHash = await hashToken(token);
  const rows = await ctx.db
    .query("auth_sessions")
    .withIndex("by_token_hash", (q) => q.eq("token_hash", tokenHash))
    .collect();
  // Attach tickets are connect credentials, never device logins: they ride
  // the popup URL (so they can land in browser history) and must not resolve
  // a roster here.
  return rows
    .filter((r) => !r.ticket)
    .sort((a, b) => a.created_at - b.created_at);
}

/**
 * Attach an account to the USER behind an existing token (by hash — the raw
 * token never round-trips through the OAuth state). If the account already
 * belongs to another user, that proves both rosters are one person: the
 * users merge. Returns false when the hash matches no session, so a forged
 * or expired attach fails closed instead of minting access.
 */
export async function attachAccountToSession(
  ctx: WriteCtx,
  tokenHash: string,
  accountId: Id<"accounts">,
): Promise<boolean> {
  const now = Date.now();
  const rows = (
    await ctx.db
      .query("auth_sessions")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", tokenHash))
      .collect()
  )
    // A limited login (an app, an agent terminal) never attaches a mailbox:
    // that would let it add Gmail accounts to the person's roster.
    .filter((r) => !rowIsLimited(r))
    .filter((r) => !r.ticket || now - r.created_at <= ATTACH_TICKET_TTL_MS);
  if (rows.length === 0) return false;

  const userId = await ensureUserForSessions(ctx, rows);
  const account = await ctx.db.get(accountId);
  if (!account) return false;
  if (!account.user_id) {
    await ctx.db.patch(accountId, { user_id: userId, updated_at: Date.now() });
  } else if (account.user_id !== userId) {
    // Same person, two rosters — the connect is the proof. Keep the session's
    // user (it holds this device's login) and fold the other in.
    await mergeUsers(ctx, userId, account.user_id);
  }
  return true;
}

/**
 * The user behind a set of session rows, upgrading legacy rows in place: a
 * pre-migration token's accounts get an owner, and its rows collapse onto
 * one user-bearing row so the next resolve takes the fast path.
 */
export async function ensureUserForSessions(
  ctx: WriteCtx,
  rows: Doc<"auth_sessions">[],
): Promise<Id<"users">> {
  const stamped = rows.find((r) => r.user_id);
  if (stamped) return stamped.user_id!;

  // Legacy token: adopt the first account's user (creating it), then bring
  // every other listed account under the same owner.
  const ordered = [...rows].sort((a, b) => a.created_at - b.created_at);
  let userId: Id<"users"> | null = null;
  for (const row of ordered) {
    const account = row.account_id ? await ctx.db.get(row.account_id) : null;
    if (!account) continue;
    if (userId === null) {
      userId = await ensureUserForAccount(ctx, account);
    } else if (!account.user_id) {
      await ctx.db.patch(account._id, { user_id: userId, updated_at: Date.now() });
    } else if (account.user_id !== userId) {
      await mergeUsers(ctx, userId, account.user_id);
    }
  }
  if (userId === null) throw new Error("Unauthorized: account no longer exists");
  for (const row of rows) {
    await ctx.db.patch(row._id, { user_id: userId });
  }
  return userId;
}

/** How stale `last_seen_at` may get before a use writes it again. Settings
 *  shows it to the minute; writing on every call would only add contention. */
export const TOUCH_INTERVAL_MS = 60 * 1000;

/** Mutation-path liveness stamp. Never throws — it is bookkeeping, not auth.
 *  A Convex Auth caller has no legacy session row to stamp. Runs after the
 *  caller's access was checked, so it stamps app rows too: their
 *  `last_seen_at` is the "last used" Settings shows. */
export async function touchSession(
  ctx: WriteCtx,
  token?: string,
): Promise<void> {
  if (!token) return;
  const now = Date.now();
  for (const session of await rowsForToken(ctx, token)) {
    if (now - session.last_seen_at < TOUCH_INTERVAL_MS) continue;
    await ctx.db.patch(session._id, { last_seen_at: now });
  }
}

/**
 * The caller as a USER id, for write paths that key rows on the person
 * (prefs). Convex Auth identity first; else the legacy token's sessions,
 * upgraded in place on their first write exactly as before.
 */
export async function requireUserId(
  ctx: WriteCtx,
  token?: string,
  scope?: ScopeNeed,
): Promise<Id<"users">> {
  const callerId = await authUserId(ctx);
  if (callerId) return callerId;
  if (!token) throw new Error("Unauthorized: missing token");
  const sessions = await sessionsForToken(ctx, token, scope);
  if (sessions.length === 0) throw new Error("Unauthorized: unknown token");
  return await ensureUserForSessions(ctx, sessions);
}
