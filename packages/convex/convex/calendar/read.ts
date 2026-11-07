import { v } from "convex/values";
import { deltaPage } from "@platform/engine-convex";
import { query } from "../_generated/server";
import { requireAccounts } from "../lib/auth";

const MAX_EVENT_LIMIT = 2000;

export const listCalendars = query({
  args: { token: v.optional(v.string()), since: v.optional(v.number()) },
  handler: async (ctx, { token, since }) => {
    const accounts = await requireAccounts(ctx, token, "calendar.read");
    const out = [];
    for (const account of accounts) {
      const rows = await ctx.db
        .query("calendars")
        .withIndex("by_account", (q) =>
          since === undefined
            ? q.eq("account_id", account._id)
            : q.eq("account_id", account._id).gt("updated_at", since),
        )
        .collect();
      // The sync token is a server cursor; the client has no use for it. The
      // window stays: events outside window_start..window_end are not
      // mirrored, so a reader (a connected app) must not call that time free.
      out.push(...rows.map(({ sync_token: _token, full_synced_at: _full, ...row }) => row));
    }
    return out;
  },
});

export const listEvents = query({
  args: {
    token: v.optional(v.string()),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { token, since, limit }) => {
    const accounts = await requireAccounts(ctx, token, "calendar.read");
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("limit must be a positive integer");
    if (since !== undefined && (!Number.isFinite(since) || since < 0)) throw new Error("since must be a finite nonnegative timestamp");
    const take = Math.min(limit ?? MAX_EVENT_LIMIT, MAX_EVENT_LIMIT);
    const from = since ?? 0;

    const pages = [];
    for (const account of accounts) {
      pages.push(
        await deltaPage(ctx, {
          table: "events",
          index: "by_account_updated",
          range: (q, from) => q.eq("account_id", account._id).gt("updated_at", from),
          since: from,
          limit: take,
          project: (row) => row,
        }),
      );
    }
    const rows = pages
      .flatMap((p) => p.rows)
      .sort((a, b) => a.updated_at - b.updated_at);
    const hasMore = pages.some((p) => p.hasMore);
    const nextSince = hasMore
      ? Math.min(...pages.filter((p) => p.hasMore).map((p) => p.nextSince))
      : pages.reduce((max, p) => Math.max(max, p.nextSince), from);
    return { rows, nextSince, hasMore };
  },
});
