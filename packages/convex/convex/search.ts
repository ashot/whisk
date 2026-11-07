import { v } from "convex/values";
import { action, internalQuery, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { requireAccount, requireAccounts } from "./lib/auth";
import { scopeNeedValidator } from "./lib/apps";
import { actionAccounts } from "./lib/actionAuth";
import { publicThread } from "./lib/rows";
import { Id } from "./_generated/dataModel";
import { SYSTEM_LABEL_IDS } from "./lib/threads";
import {
  isEmptyQuery,
  matchThread,
  parseQuery,
} from "@mail/shared/src/lib/searchQuery";
import {
  getAccessToken,
  getThread,
  GmailApiError,
  isRateLimited,
  listThreads as gmailListThreads,
  parseGmailMessage,
  type ParsedMessage,
} from "./gmail/api";

// Local search over the synced projection: subject, participants and snippet.
// The grammar lives in @mail/shared so the client's live filter answers the
// same operators the same way.

const DEFAULT_LIMIT = 50;
// How many recent threads a query is allowed to walk. A mailbox capped at ~1000
// synced threads never reaches this, and it bounds the worst case if it grows.
const SCAN_CAP = 4000;

export const searchThreads = query({
  args: {
    // Optional during the Convex Auth migration: signed-in callers resolve
    // from ctx.auth and send no token.
    token: v.optional(v.string()),
    q: v.string(),
    limit: v.optional(v.number()),
    accountId: v.optional(v.id("accounts")),
  },
  handler: async (ctx, { token, q, limit, accountId }) => {
    // Scope: one account when the client is scoped, every session account in
    // the unified view.
    const accounts = accountId
      ? [await requireAccount(ctx, token, accountId, "mail.read")]
      : await requireAccounts(ctx, token, "mail.read");
    const parsed = parseQuery(q);
    const take = limit ?? DEFAULT_LIMIT;
    if (isEmptyQuery(parsed)) return [];

    const hits: ReturnType<typeof publicThread>[] = [];
    for (const account of accounts) {
      const labelNameById = new Map<string, string>();
      if (parsed.labels.length > 0) {
        const labels = await ctx.db
          .query("labels")
          .withIndex("by_account", (qq) => qq.eq("account_id", account._id))
          .collect();
        for (const label of labels)

          labelNameById.set(label.gmail_id, label.name);
      }

      let scanned = 0;
      let accountHits = 0;
      for await (const thread of ctx.db
        .query("threads")
        .withIndex("by_account_last", (qq) => qq.eq("account_id", account._id))
        .order("desc")) {
        if (++scanned > SCAN_CAP) break;
        if (thread.deleted) continue;
        // Trash and spam stay out of general search, matching Gmail.
        if (
          thread.label_ids.includes(SYSTEM_LABEL_IDS.TRASH) ||
          thread.label_ids.includes(SYSTEM_LABEL_IDS.SPAM)
        ) {
          continue;
        }
        if (!matchThread(thread, parsed, labelNameById)) continue;
        hits.push(publicThread(thread));
        if (++accountHits >= take) break;
      }
    }
    return hits;
  },
});

// ---------------------------------------------------------------------------
// Full search: Gmail's own query engine over the whole mailbox, one page at a
// time. The cursor is opaque to callers: a JSON map of account id to Gmail
// page token, holding only the accounts that still have pages.
// ---------------------------------------------------------------------------

// Hits per account per page. Gmail ranks by recency; the caller follows the
// cursor for more.
export const REMOTE_PAGE = 50;
const REMOTE_FETCH_CONCURRENCY = 5;

type SearchCursor = Record<string, string>;

export const accountsForToken = internalQuery({
  // Called from runFullSearch via ctx.runQuery, which carries the action
  // caller's ctx.auth through — so the dual resolution works here too.
  // `scope` is what the calling action needs from an app token (lib/apps):
  // one scope, or a list that must all be held.
  args: {
    token: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
    scope: scopeNeedValidator,
  },
  handler: async (ctx, { token, accountId, scope }) => {
    const accounts = accountId
      ? [await requireAccount(ctx, token, accountId, scope)]
      : await requireAccounts(ctx, token, scope);
    return accounts.map((a) => ({ _id: a._id, provider: a.provider }));
  },
});

export const knownThreadIds = internalQuery({
  args: { accountId: v.id("accounts"), gmailIds: v.array(v.string()) },
  handler: async (ctx, { accountId, gmailIds }) => {
    const known: string[] = [];
    for (const gmailId of gmailIds) {
      const thread = await ctx.db
        .query("threads")
        .withIndex("by_account_gmail", (q) =>
          q.eq("account_id", accountId).eq("gmail_id", gmailId),
        )
        .unique();
      if (thread && !thread.deleted && thread.message_count > 0) {
        known.push(gmailId);
      }
    }
    return known;
  },
});

/** The hit rows themselves, in the order asked. Search is the one path that
 *  surfaces threads older than the client's synced window, so the rows ride
 *  back with the result instead of relying on the thread stream. */
export const threadRows = internalQuery({
  args: { accountId: v.id("accounts"), gmailIds: v.array(v.string()) },
  handler: async (ctx, { accountId, gmailIds }) => {
    const rows: ReturnType<typeof publicThread>[] = [];
    for (const gmailId of gmailIds) {
      const thread = await ctx.db
        .query("threads")
        .withIndex("by_account_gmail", (q) =>
          q.eq("account_id", accountId).eq("gmail_id", gmailId),
        )
        .unique();
      if (thread && !thread.deleted) rows.push(publicThread(thread));
    }
    return rows;
  },
});

export type FullSearchPage = {
  rows: ReturnType<typeof publicThread>[];
  /** Pass back to fetch the next page; null when every account is drained. */
  cursor: string | null;
};

/**
 * One page of Gmail's own results for the query (bodies, older mail than the
 * local projection), imported into the projection and returned as rows in
 * Gmail's rank order. Demo accounts answer from the local projection instead,
 * in a single page.
 */
export const runFullSearch = action({
  args: {
    token: v.optional(v.string()),
    q: v.string(),
    accountId: v.optional(v.id("accounts")),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { token, q, accountId, cursor }): Promise<FullSearchPage> => {
    if (!q.trim()) return { rows: [], cursor: null };
    const accounts = await actionAccounts(ctx, { token, accountId, scope: "mail.read" });

    const gmailAccounts = accounts.filter((a) => a.provider === "gmail");
    // No Gmail upstream anywhere in scope (demo): the local pass IS the full
    // search, and it has one page.
    if (gmailAccounts.length === 0) {
      if (cursor) return { rows: [], cursor: null };
      const rows: FullSearchPage["rows"] = await ctx.runQuery(
        api.search.searchThreads,
        { token, q, accountId },
      );
      return { rows, cursor: null };
    }

    // The first page asks every account; later pages only the ones that said
    // they had more.
    const pageTokens: SearchCursor = cursor ? JSON.parse(cursor) : {};
    const pending = cursor
      ? gmailAccounts.filter((a) => a._id in pageTokens)
      : gmailAccounts;

    const rows: FullSearchPage["rows"] = [];
    const next: SearchCursor = {};
    for (const account of pending) {
      const accessToken = await getAccessToken(ctx, account._id);
      const page = await gmailListThreads(accessToken, {
        q,
        maxResults: REMOTE_PAGE,
        pageToken: pageTokens[account._id],
      });
      if (page.nextPageToken) next[account._id] = page.nextPageToken;
      const ids = (page.threads ?? []).map((t) => t.id);
      if (ids.length === 0) continue;

      const known = new Set(
        await ctx.runQuery(internal.search.knownThreadIds, {
          accountId: account._id,
          gmailIds: ids,
        }),
      );
      const missing = ids.filter((id) => !known.has(id));
      // A thread Gmail would not hand over for quota is still a hit: the
      // cursor asks this page again, where it is the only one left to fetch.
      // Any other failure (a thread deleted since the list) is skipped.
      let throttled = false;
      for (let i = 0; i < missing.length; i += REMOTE_FETCH_CONCURRENCY) {
        const chunk = missing.slice(i, i + REMOTE_FETCH_CONCURRENCY);
        const threads = await Promise.all(
          chunk.map((id) =>
            getThread(accessToken, id).catch((caught) => {
              if (caught instanceof GmailApiError && isRateLimited(caught.status, caught.body)) {
                throttled = true;
              }
              return null;
            }),
          ),
        );
        const messages: ParsedMessage[] = [];
        for (const thread of threads) {
          for (const message of thread?.messages ?? []) {
            messages.push(parseGmailMessage(message));
          }
        }
        if (messages.length > 0) {
          await ctx.runMutation(internal.gmail.sync.applySyncedMessages, {
            accountId: account._id,
            messages,
          });
        }
      }
      // The first page has no token; "" asks for it again.
      if (throttled) next[account._id] = pageTokens[account._id] ?? "";
      rows.push(
        ...(await ctx.runQuery(internal.search.threadRows, {
          accountId: account._id,
          gmailIds: ids,
        })),
      );
    }
    return {
      rows,
      cursor: Object.keys(next).length > 0 ? JSON.stringify(next) : null,
    };
  },
});
