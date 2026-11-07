import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { IMPORTANT } from "@mail/shared/src/lib/lenses";
import { adoptGmailDraft, isGmailDraft } from "./lib/drafts";
import { isSealed, resealLegacyCredential } from "./lib/credentials";
import { settleThread, threadByGmailId } from "./lib/threads";
import {
  ensureUserForAccount,
  ensureUserForSessions,
  hasAuthIdentity,
  mergeUsers,
} from "./lib/auth";

/**
 * Backfill for the users table: every existing session, account, and prefs
 * row gets an owner. Grouping session rows by token first keeps a legacy
 * multi-account session as ONE user; ungrouped accounts each get their own.
 * Idempotent — stamped rows are skipped — so it can run more than once.
 */
export const backfillUsers = internalMutation({
  args: {},
  handler: async (ctx) => {
    // 1. Sessions, grouped by token: each group collapses onto one user.
    const sessions = await ctx.db.query("auth_sessions").collect();
    const byToken = new Map<string, typeof sessions>();
    for (const row of sessions) {
      const group = byToken.get(row.token_hash) ?? [];
      group.push(row);
      byToken.set(row.token_hash, group);
    }
    let sessionsUpgraded = 0;
    for (const group of byToken.values()) {
      if (group.every((r) => r.user_id)) continue;
      // A token whose accounts are all gone has nothing to own — drop it.
      let hasAccount = false;
      for (const row of group) {
        if (row.account_id && (await ctx.db.get(row.account_id))) {
          hasAccount = true;
          break;
        }
      }
      if (!hasAccount) {
        for (const row of group) await ctx.db.delete(row._id);
        continue;
      }
      await ensureUserForSessions(ctx, group);
      sessionsUpgraded++;
    }

    // 2. Accounts nothing pointed at (no session survived): own themselves.
    let accountsStamped = 0;
    for (const account of await ctx.db.query("accounts").collect()) {
      if (!account.user_id) {
        await ensureUserForAccount(ctx, account);
        accountsStamped++;
      }
    }

    // 3. Prefs rows still keyed by account: move to the account's user. When
    // the user already has a prefs row, the newer one wins.
    let prefsMoved = 0;
    for (const state of await ctx.db.query("client_state").collect()) {
      if (state.user_id || !state.account_id) continue;
      const account = await ctx.db.get(state.account_id);
      if (!account?.user_id) continue;
      const existing = await ctx.db
        .query("client_state")
        .withIndex("by_user", (q) => q.eq("user_id", account.user_id))
        .unique();
      if (existing) {
        if (state.updated_at > existing.updated_at) {
          await ctx.db.delete(existing._id);
          await ctx.db.patch(state._id, { user_id: account.user_id });
        } else {
          await ctx.db.delete(state._id);
        }
      } else {
        await ctx.db.patch(state._id, { user_id: account.user_id });
      }
      prefsMoved++;
    }

    return { sessionsUpgraded, accountsStamped, prefsMoved };
  },
});

/**
 * ct-44709 — prepare legacy rows for Convex Auth sign-in. NOT run anywhere
 * automatically. Run it ONCE per deployment, by hand, AFTER the Convex Auth
 * schema and Google provider are deployed and BEFORE announcing sign-in:
 *
 *   npx convex run migrations:linkLegacyUsersForConvexAuth
 *
 * Idempotent, so re-running is safe.
 *
 * Whisk's users table IS Convex Auth's users table, so no rows move. What
 * legacy rows lack is the `email` field the auth sign-in dedupes on:
 *
 * 1. auth_sessions rows still keyed by account_id (pre-users-table tokens)
 *    get an owner via ensureUserForSessions — the same upgrade the resolver
 *    performs lazily, done eagerly here so step 2 sees every user.
 * 2. Every user row missing `email` gets primary_email, lowercased. When two
 *    users claim one address, the first (oldest) keeps it and the other
 *    merges into it — the same one-person proof the attach flow uses. A row
 *    that can sign in on its own always survives that merge, and two such
 *    rows are left alone: a merge deletes the loser, and deleting a working
 *    login is not a call a backfill gets to make.
 *
 * After this, a Google sign-in with a known address lands on the existing
 * user through makeCreateOrUpdateUser's email dedup, and the whole roster
 * follows the sign-in.
 */
export const linkLegacyUsersForConvexAuth = internalMutation({
  args: {},
  handler: async (ctx) => {
    // 1. Account-keyed session rows get an owner, grouped by token so a
    // legacy multi-account session stays ONE user (same as backfillUsers).
    const sessions = await ctx.db.query("auth_sessions").collect();
    const byToken = new Map<string, typeof sessions>();
    for (const row of sessions) {
      const group = byToken.get(row.token_hash) ?? [];
      group.push(row);
      byToken.set(row.token_hash, group);
    }
    let sessionsUpgraded = 0;
    for (const group of byToken.values()) {
      if (group.every((r) => r.user_id)) continue;
      let hasAccount = false;
      for (const row of group) {
        if (row.account_id && (await ctx.db.get(row.account_id))) {
          hasAccount = true;
          break;
        }
      }
      if (!hasAccount) continue; // nothing to own; the resolver rejects it
      await ensureUserForSessions(ctx, group);
      sessionsUpgraded++;
    }

    // 2. Stamp `email` from primary_email; merge duplicate claims.
    let emailsStamped = 0;
    let usersMerged = 0;
    let usersLeftAlone = 0;
    const byEmail = new Map<string, Id<"users">>();
    const stampEmail = async (userId: Id<"users">, email: string) => {
      byEmail.set(email, userId);
      const row = await ctx.db.get(userId);
      if (row && row.email !== email) {
        await ctx.db.patch(userId, { email });
        emailsStamped++;
      }
    };
    for (const user of await ctx.db.query("users").collect()) {
      const email = (user.email ?? user.primary_email)?.toLowerCase().trim();
      if (!email) continue;
      const holder = byEmail.get(email);
      if (holder && holder !== user._id) {
        // The oldest row keeps the address, unless the newer one is the one
        // that can sign in on its own — that row has to be the survivor.
        const survivor = (await hasAuthIdentity(ctx, user._id))
          ? user._id
          : holder;
        const merged = survivor === holder ? user._id : holder;
        if (await hasAuthIdentity(ctx, merged)) {
          usersLeftAlone++;
          continue;
        }
        await mergeUsers(ctx, survivor, merged);
        usersMerged++;
        await stampEmail(survivor, email);
        continue;
      }
      await stampEmail(user._id, email);
    }

    return { sessionsUpgraded, emailsStamped, usersMerged, usersLeftAlone };
  },
});

/**
 * Gmail drafts synced before they became drafts sit in `messages` with the
 * DRAFT label. Each becomes a draft and leaves its thread, the same as sync
 * now does on arrival. Pages through every message and schedules itself
 * until done; idempotent. `refresh` also rewrites drafts already adopted
 * from their (now retired) messages, leaving discarded ones discarded.
 *
 *   npx convex run migrations:adoptStoredGmailDrafts
 */
export const adoptStoredGmailDrafts = internalMutation({
  args: { cursor: v.optional(v.string()), refresh: v.optional(v.boolean()) },
  handler: async (ctx, { cursor, refresh }) => {
    const page = await ctx.db.query("messages").paginate({ cursor: cursor ?? null, numItems: 100 });
    let adopted = 0;
    for (const m of page.page) {
      if (!isGmailDraft(m) || (m.deleted && !refresh)) continue;
      const thread = await threadByGmailId(ctx, m.account_id, m.thread_gmail_id);
      // A retired message only repairs its draft; it never brings one back.
      await adoptGmailDraft(ctx, m.account_id, { ...m, subject: thread?.subject ?? "" }, { rewrite: refresh, create: !m.deleted });
      if (!m.deleted) {
        await ctx.db.patch(m._id, { deleted: true, updated_at: Date.now() });
        await settleThread(ctx, m.account_id, m.thread_gmail_id);
      }
      adopted++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.adoptStoredGmailDrafts, { cursor: page.continueCursor, refresh });
    }
    return { adopted, done: page.isDone };
  },
});

/**
 * Bring every Gmail credential to the current sealed form (lib/credentials.ts):
 * rows in the clear and rows sealed unbound (enc1) are rewritten sealed and
 * bound to their account and field (enc2). Idempotent: a value already in the
 * current form is left as it is, so a rerun only reaches rows written in an
 * older form since. Needs WHISK_CREDENTIALS_KEY set first; without it the
 * first row throws and nothing is written.
 *
 *   npx convex run migrations:sealCredentials
 */
export const sealCredentials = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("credentials").paginate({ cursor: cursor ?? null, numItems: 100 });
    let sealed = 0;
    for (const row of page.page) {
      if (isSealed(row.access_token) && isSealed(row.refresh_token)) continue;
      await ctx.db.patch(row._id, {
        access_token: await resealLegacyCredential(row.access_token, row.account_id, "access_token"),
        refresh_token: await resealLegacyCredential(row.refresh_token, row.account_id, "refresh_token"),
      });
      sealed++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.sealCredentials, { cursor: page.continueCursor });
    }
    return { sealed, done: page.isDone };
  },
});

/** How many credentials rows still hold a token in an older form (in the
 *  clear, or sealed but not bound to its row). Zero after the migration; the
 *  assessment evidence is this query's answer.
 *
 *   npx convex run migrations:unsealedCredentials
 */
export const unsealedCredentials = internalQuery({
  args: {},
  handler: async (ctx) => {
    let unsealed = 0;
    let total = 0;
    for (const row of await ctx.db.query("credentials").collect()) {
      total++;
      if (!isSealed(row.access_token) || !isSealed(row.refresh_token)) unsealed++;
    }
    return { total, unsealed };
  },
});

/**
 * Move the single-lens importance fields into the lens maps: a verdict
 * becomes a score on the Important lens (high or low, until the next judge
 * pass scores it properly), a hand mark becomes a placement. Pages through
 * every thread and reschedules itself.
 *   npx convex run migrations:lensesFromImportance
 */
export const lensesFromImportance = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("threads").paginate({ cursor: cursor ?? null, numItems: 200 });
    let moved = 0;
    for (const t of page.page) {
      if (t.important === undefined && t.important_by === undefined && t.important_why === undefined) continue;
      const patch: Partial<Doc<"threads">> = { important: undefined, important_by: undefined, important_why: undefined };
      if (t.important !== undefined && t.important_by === "user") {
        patch.lens_marks = { ...(t.lens_marks ?? {}), [IMPORTANT]: t.important };
        patch.marked_at = t.updated_at;
      } else if (t.important !== undefined && t.lens_scores?.[IMPORTANT] === undefined) {
        patch.lens_scores = { ...(t.lens_scores ?? {}), [IMPORTANT]: t.important ? 80 : 20 };
        if (t.important_why) patch.lens_why = { ...(t.lens_why ?? {}), [IMPORTANT]: t.important_why };
      }
      await ctx.db.patch(t._id, patch);
      moved++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.migrations.lensesFromImportance, { cursor: page.continueCursor });
    return { moved, done: page.isDone };
  },
});
