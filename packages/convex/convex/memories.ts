import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireAccounts } from "./lib/auth";

// What Whisk knows, readable by its owner. Writes go through dispatch
// (addMemory / deleteMemory) and the extraction pipelines; this is the sync
// channel the memory view renders from.

export const listMemories = query({
  args: { token: v.optional(v.string()), since: v.optional(v.number()) },
  handler: async (ctx, { token, since }) => {
    const accounts = await requireAccounts(ctx, token, "mail.read");
    const out = [];
    for (const account of accounts) {
      const rows = await ctx.db
        .query("memories")
        .withIndex("by_account", (q) =>
          since === undefined
            ? q.eq("account_id", account._id)
            : q.eq("account_id", account._id).gt("updated_at", since),
        )
        .collect();
      out.push(...rows);
    }
    return out;
  },
});
