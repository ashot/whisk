import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { mailReader, readerFor } from "../lib/privacy";

// Catch up on a thread without reading it. Summaries cache by message count:
// reopening costs nothing until new mail lands in the thread. `latest` asks
// about the newest message alone (what a notification announces) and caches
// beside the whole-thread summary. The model call lives in ai/actions.ts
// (Node runtime).

/** Earlier messages a `latest` summary reads to know what the new one
 *  answers ("Sure, I'll do that" means nothing alone). */
const LATEST_CONTEXT = 3;

export const summaryContext = internalQuery({
  args: {
    token: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
    threadGmailId: v.string(),
    /** The server asking on the account's behalf (a notification), with no
     *  person's session to check. Internal callers only. */
    system: v.optional(v.boolean()),
    latest: v.optional(v.boolean()),
  },
  handler: async (ctx, { token, accountId, threadGmailId, system, latest }) => {
    // A notification is the server itself, never an agent.
    const reader =
      system && accountId
        ? await readerFor(ctx, [await ctx.db.get(accountId)].filter((a) => a !== null), false)
        : await mailReader(ctx, token, "mail.read", accountId);
    for (const account of reader.accounts) {
      const thread = await ctx.db
        .query("threads")
        .withIndex("by_account_gmail", (q) =>
          q.eq("account_id", account._id).eq("gmail_id", threadGmailId),
        )
        .unique();
      if (!thread || thread.deleted || !reader.sees(thread)) continue;

      const cached = await ctx.db
        .query("thread_ai")
        .withIndex("by_account_thread", (q) =>
          q.eq("account_id", account._id).eq("thread_gmail_id", threadGmailId),
        )
        .unique();
      const hit = latest
        ? cached?.latest_message_count === thread.message_count && cached.latest_summary
        : cached?.message_count === thread.message_count && cached.summary;
      const owner = { name: account.name, email: account.email };
      if (hit) return { account_id: account._id, owner, cached: hit, messages: [], earlier: [] };

      const rows = await ctx.db
        .query("messages")
        .withIndex("by_account_thread", (q) =>
          q.eq("account_id", account._id).eq("thread_gmail_id", threadGmailId),
        )
        .order("asc")
        .collect();
      const live = rows
        .filter((m) => !m.deleted)
        .map((m) => ({ from: m.from, date: m.date, body_text: m.body_text, snippet: m.snippet }));
      return {
        account_id: account._id,
        owner,
        cached: null,
        message_count: thread.message_count,
        subject: thread.subject,
        messages: latest ? live.slice(-1) : live,
        /** With `latest`: the messages before it, which say what it answers. */
        earlier: latest ? live.slice(-1 - LATEST_CONTEXT, -1) : [],
      };
    }
    throw new Error("Thread not found");
  },
});

export const storeSummary = internalMutation({
  args: {
    accountId: v.id("accounts"),
    threadGmailId: v.string(),
    summary: v.string(),
    messageCount: v.number(),
    latest: v.optional(v.boolean()),
  },
  handler: async (ctx, { accountId, threadGmailId, summary, messageCount, latest }) => {
    const existing = await ctx.db
      .query("thread_ai")
      .withIndex("by_account_thread", (q) =>
        q.eq("account_id", accountId).eq("thread_gmail_id", threadGmailId),
      )
      .unique();
    const row = latest
      ? { latest_summary: summary, latest_message_count: messageCount, updated_at: Date.now() }
      : { summary, message_count: messageCount, updated_at: Date.now() };
    if (existing) await ctx.db.patch(existing._id, row);
    else {
      await ctx.db.insert("thread_ai", {
        account_id: accountId,
        thread_gmail_id: threadGmailId,
        ...row,
      });
    }
  },
});

