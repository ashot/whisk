import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { sanitizeCategory } from "../lib/categorize";

// The read and write halves of model classification. The model call itself
// lives in ai/actions.ts (Node runtime); rules and heuristics already ran
// inside the sync mutation — only threads neither could place get here.

export const threadsForClassification = internalQuery({
  args: { accountId: v.id("accounts"), threadGmailIds: v.array(v.string()) },
  handler: async (ctx, { accountId, threadGmailIds }) => {
    const out: Array<{
      gmail_id: string;
      from: string;
      subject: string;
      snippet: string;
    }> = [];
    for (const gmailId of threadGmailIds) {
      const thread = await ctx.db
        .query("threads")
        .withIndex("by_account_gmail", (q) =>
          q.eq("account_id", accountId).eq("gmail_id", gmailId),
        )
        .unique();
      // Skip anything settled since scheduling: a user or rule verdict is
      // final, and an "ai" verdict (even primary) means already asked.
      if (!thread || thread.deleted || thread.category_source) continue;
      const sender =
        thread.participants.find((p) => p.email)?.name ??
        thread.participants[0]?.email ??
        "";
      const senderEmail = thread.participants[0]?.email ?? "";
      out.push({
        gmail_id: gmailId,
        from: `${sender} <${senderEmail}>`,
        subject: thread.subject.slice(0, 120),
        snippet: thread.snippet.slice(0, 160),
      });
    }
    return out;
  },
});

export const applyCategories = internalMutation({
  args: {
    accountId: v.id("accounts"),
    entries: v.array(
      v.object({
        thread_gmail_id: v.string(),
        category: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (ctx, { accountId, entries }) => {
    const now = Date.now();
    for (const entry of entries) {
      const thread = await ctx.db
        .query("threads")
        .withIndex("by_account_gmail", (q) =>
          q.eq("account_id", accountId).eq("gmail_id", entry.thread_gmail_id),
        )
        .unique();
      if (!thread || thread.deleted) continue;
      // Never override a human or a learned rule; re-answering an earlier ai
      // verdict is fine (a retried batch).
      if (thread.category_source === "user" || thread.category_source === "rule") {
        continue;
      }
      const category = sanitizeCategory(entry.category) ?? undefined;
      if (thread.category === category && thread.category_source === "ai") continue;
      await ctx.db.patch(thread._id, {
        category,
        category_source: "ai",
        updated_at: now,
      });
    }
  },
});

