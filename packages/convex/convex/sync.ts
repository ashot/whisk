import { THREAD_WINDOW } from "./lib/rows";
import { hasCalendarScope } from "./gmail/oauth";
import { v } from "convex/values";
import { deltaPage } from "@platform/engine-convex";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAccount, requireAccounts, touchSession } from "./lib/auth";
import {
  publicAccount,
  publicClientState,
  publicDraft,
  publicLabel,
  publicMessage,
  publicThread,
} from "./lib/rows";

// Two read modes on listThreads, both shipping { rows, nextSince, hasMore }:
//   snapshot — no `since`: the newest rows by recency (`by_account_last`,
//              descending), for a cold client.
//   delta    — with `since`: everything touched after a watermark, in
//              `updated_at` order. Tombstones (`deleted: true`) ride the
//              same channel, which is why no query filters them out.
//
// The delta branch pages through `deltaPage` from @platform/engine-convex.
// Its rule: never advance `nextSince` past a timestamp not fully returned.
// Writes in one transaction share an `updated_at`, so a bare
// `gt(updated_at).take(n)` whose boundary lands inside such a group would let
// the client advance its watermark past rows it never saw. The snapshot
// branch stays on the recency index — `deltaPage` only walks the watermark
// index upward, and a cold client needs the NEWEST rows — and always reports
// `hasMore: false`.
//
// listLabels and listDrafts `collect()` their whole delta (no page cap), so
// they keep their bare-array shape.

const DEFAULT_THREAD_LIMIT = 1000;
const MAX_THREAD_LIMIT = THREAD_WINDOW;

// `token` is optional on every function here during the Convex Auth
// migration: a signed-in caller resolves from ctx.auth and sends none.

export const listThreads = query({
  args: {
    token: v.optional(v.string()),
    limit: v.optional(v.number()),
    since: v.optional(v.number()),
  },
  handler: async (ctx, { token, limit, since }) => {
    const accounts = await requireAccounts(ctx, token, "mail.read");
    const take = Math.min(limit ?? DEFAULT_THREAD_LIMIT, MAX_THREAD_LIMIT);

    // One merged stream over every account in the session; each row carries
    // its account_id and the client scopes locally. The limit applies per
    // account: simpler than a fair global cut, and each mailbox already caps
    // its own projection.
    if (since === undefined) {
      const rows: ReturnType<typeof publicThread>[] = [];
      for (const account of accounts) {
        const page = await ctx.db
          .query("threads")
          .withIndex("by_account_last", (q) => q.eq("account_id", account._id))
          .order("desc")
          .take(take);
        rows.push(...page.map(publicThread));
      }
      const nextSince = rows.reduce((max, r) => Math.max(max, r.updated_at), 0);
      return { rows, nextSince, hasMore: false };
    }

    const pages = [];
    for (const account of accounts) {
      pages.push(
        await deltaPage(ctx, {
          table: "threads",
          index: "by_account_updated",
          range: (q, from) => q.eq("account_id", account._id).gt("updated_at", from),
          since,
          limit: take,
          project: publicThread,
        }),
      );
    }
    // Delta consumers advance a single watermark over the merged stream, so it
    // must be globally updated_at-ascending, not per-account.
    const rows = pages
      .flatMap((p) => p.rows)
      .sort((a, b) => a.updated_at - b.updated_at);
    const hasMore = pages.some((p) => p.hasMore);
    // One watermark over many accounts: with every account drained the max is
    // safe; while any account still has more, hold at the smallest undrained
    // cursor. Accounts already past it just redeliver rows the client merges
    // by id, and `deltaPage` guarantees an undrained cursor still advanced
    // past `since`, so the loop always makes progress.
    const nextSince = hasMore
      ? Math.min(...pages.filter((p) => p.hasMore).map((p) => p.nextSince))
      : pages.reduce((max, p) => Math.max(max, p.nextSince), since);
    return { rows, nextSince, hasMore };
  },
});

export const listLabels = query({
  args: { token: v.optional(v.string()), since: v.optional(v.number()) },
  handler: async (ctx, { token, since }) => {
    const accounts = await requireAccounts(ctx, token, "mail.read");
    const out: ReturnType<typeof publicLabel>[] = [];
    for (const account of accounts) {
      const rows = await ctx.db
        .query("labels")
        .withIndex("by_account", (q) =>
          since === undefined
            ? q.eq("account_id", account._id)
            : q.eq("account_id", account._id).gt("updated_at", since),
        )
        .collect();
      out.push(...rows.map(publicLabel));
    }
    return out;
  },
});

export const listDrafts = query({
  args: { token: v.optional(v.string()), since: v.optional(v.number()) },
  handler: async (ctx, { token, since }) => {
    const accounts = await requireAccounts(ctx, token, "mail.read");
    const out: ReturnType<typeof publicDraft>[] = [];
    for (const account of accounts) {
      const rows = await ctx.db
        .query("drafts")
        .withIndex("by_account", (q) =>
          since === undefined
            ? q.eq("account_id", account._id)
            : q.eq("account_id", account._id).gt("updated_at", since),
        )
        .collect();
      out.push(...rows.map(publicDraft));
    }
    return out;
  },
});

export const getAccount = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const accounts = await requireAccounts(ctx, token, "mail.read");
    if (accounts.length === 0) {
      // Signed in through Convex Auth with nothing connected yet — an
      // onboarding state, not a failure. The client shows the connect surface.
      return {
        account: null,
        accounts: [],
        client_state: null,
        outbound_pending: 0,
      };
    }
    // Prefs belong to the user and follow them across devices. Fallback: a
    // pre-migration row still keyed by the primary account.
    const userId = accounts[0].user_id;
    const state =
      (userId
        ? await ctx.db
            .query("client_state")
            .withIndex("by_user", (q) => q.eq("user_id", userId))
            .unique()
        : null) ??
      (await ctx.db
        .query("client_state")
        .withIndex("by_account", (q) => q.eq("account_id", accounts[0]._id))
        .unique());
    // Outbound depth is the only honest "is my send still in flight?" signal
    // the client has, so it rides along with the session envelope. Count both
    // queued AND inflight — a row mid-send is still pending from the user's view.
    let pending = 0;
    for (const account of accounts) {
      const queued = await ctx.db
        .query("outbound")
        .withIndex("by_account_status", (q) =>
          q.eq("account_id", account._id).eq("status", "queued"),
        )
        .take(50);
      const inflight = await ctx.db
        .query("outbound")
        .withIndex("by_account_status", (q) =>
          q.eq("account_id", account._id).eq("status", "inflight"),
        )
        .take(50);
      pending += queued.length + inflight.length;
    }
    return {
      // `account` stays as the primary for callers that predate multi-account.
      account: publicAccount(accounts[0]),
      accounts: accounts.map(publicAccount),
      client_state: publicClientState(state),
      outbound_pending: pending,
    };
  },
});

export const threadMessages = query({
  args: {
    token: v.optional(v.string()),
    threadGmailId: v.string(),
    accountId: v.optional(v.id("accounts")),
  },
  handler: async (ctx, { token, threadGmailId, accountId }) => {
    // With accountId (the thread row carries it) this is one indexed read;
    // without, fall back to scanning the session's accounts for the thread.
    const accounts = accountId
      ? [await requireAccount(ctx, token, accountId, "mail.read")]
      : await requireAccounts(ctx, token, "mail.read");
    for (const account of accounts) {
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_account_thread", (q) =>
          q.eq("account_id", account._id).eq("thread_gmail_id", threadGmailId),
        )
        .order("asc")
        .collect();
      const alive = rows.filter((m) => !m.deleted);
      if (alive.length > 0) return alive.map(publicMessage);
    }
    return [];
  },
});

/**
 * Thread rows by Gmail id, across every account the caller can read. An id
 * that names a message instead of a thread resolves to that message's
 * thread. Terminal clients hold no projection, so this is how they turn an
 * id from a list into the row the write paths need (account_id above all).
 */
export const threadsByIds = query({
  args: {
    token: v.optional(v.string()),
    gmailIds: v.array(v.string()),
  },
  handler: async (ctx, { token, gmailIds }) => {
    const accounts = await requireAccounts(ctx, token, "mail.read");
    const rows: ReturnType<typeof publicThread>[] = [];
    for (const gmailId of gmailIds.slice(0, 200)) {
      for (const account of accounts) {
        let thread = await ctx.db
          .query("threads")
          .withIndex("by_account_gmail", (q) =>
            q.eq("account_id", account._id).eq("gmail_id", gmailId),
          )
          .unique();
        if (!thread) {
          const message = await ctx.db
            .query("messages")
            .withIndex("by_account_gmail", (q) =>
              q.eq("account_id", account._id).eq("gmail_id", gmailId),
            )
            .unique();
          if (message && !message.deleted) {
            thread = await ctx.db
              .query("threads")
              .withIndex("by_account_gmail", (q) =>
                q
                  .eq("account_id", account._id)
                  .eq("gmail_id", message.thread_gmail_id),
              )
              .unique();
          }
        }
        if (thread && !thread.deleted) {
          rows.push(publicThread(thread));
          break;
        }
      }
    }
    return rows;
  },
});

/**
 * Client calls this on window focus. Gmail accounts get an incremental history
 * pass scheduled; demo accounts have nothing upstream to pull, so it only
 * stamps liveness.
 */
export const refresh = mutation({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const accounts = await requireAccounts(ctx, token, "mail.read");
    await touchSession(ctx, token);
    let scheduled = 0;
    for (const account of accounts) {
      if (account.provider !== "gmail") continue;
      if (hasCalendarScope(account.scopes)) {
        await ctx.scheduler.runAfter(0, internal.calendar.sync.syncAccount, { accountId: account._id });
      }
      if (
        account.sync_status === "backfilling" ||
        account.sync_status === "syncing"
      ) {
        continue;
      }
      await ctx.scheduler.runAfter(0, internal.gmail.sync.incremental, {
        accountId: account._id,
      });
      scheduled++;
    }
    return { scheduled: scheduled > 0 };
  },
});
