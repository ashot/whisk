import { v } from "convex/values";
import { query } from "./_generated/server";
import { resolveCaller } from "./lib/auth";

// What Whisk knows, readable by its owner. Writes go through dispatch
// (addMemory / deleteMemory) and the extraction pipelines; this is the sync
// channel the memory view renders from.

export const listMemories = query({
  args: { token: v.optional(v.string()), since: v.optional(v.number()) },
  handler: async (ctx, { token, since }) => {
    const { accounts, hidesPrivate } = await resolveCaller(ctx, token, "mail.read");
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
      // Filing rules and notes about people name the people the person
      // corresponds with, private mail's included; a login kept from private
      // mail gets how they write and what they prefer, nothing about whom.
      out.push(...(hidesPrivate ? rows.filter((m) => m.deleted || m.kind === "preference" || m.kind === "style") : rows));
    }
    return out;
  },
});
