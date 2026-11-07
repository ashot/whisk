import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { requireAccount, requireAccounts } from "../lib/auth";
import type { ScopeNeed } from "../lib/apps";

// Drafting in the owner's voice. The prompt is assembled from exactly three
// things: the thread transcript, the memories (voice, contacts, preferences),
// and the owner's identity. Memories are the whole personalization story —
// there is no hidden second profile.

/** What an app needs to draft from a thread. A draft or a suggestion is
 *  written from the thread's text and returned, so it reads mail: drafting
 *  alone does not reach it. */
export const DRAFT_FROM_THREAD: ScopeNeed = ["mail.read", "mail.draft"];

export const contextForThread = internalQuery({
  args: {
    token: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
    threadGmailId: v.string(),
  },
  handler: async (ctx, { token, accountId, threadGmailId }) => {
    const accounts = accountId
      ? [await requireAccount(ctx, token, accountId, DRAFT_FROM_THREAD)]
      : await requireAccounts(ctx, token, DRAFT_FROM_THREAD);

    for (const account of accounts) {
      const thread = await ctx.db
        .query("threads")
        .withIndex("by_account_gmail", (q) =>
          q.eq("account_id", account._id).eq("gmail_id", threadGmailId),
        )
        .unique();
      if (!thread || thread.deleted) continue;

      const rows = await ctx.db
        .query("messages")
        .withIndex("by_account_thread", (q) =>
          q.eq("account_id", account._id).eq("thread_gmail_id", threadGmailId),
        )
        .order("asc")
        .collect();
      const messages = rows
        .filter((m) => !m.deleted)
        .map((m) => ({
          from: m.from,
          date: m.date,
          body_text: m.body_text,
          snippet: m.snippet,
        }));

      const memoryRows = await ctx.db
        .query("memories")
        .withIndex("by_account", (q) => q.eq("account_id", account._id))
        .collect();
      const alive = memoryRows.filter((m) => !m.deleted);
      const participantEmails = new Set(
        thread.participants.map((p) => p.email.toLowerCase()),
      );
      const style = alive.filter((m) => m.kind === "style").map((m) => m.text);
      const preferences = alive
        .filter((m) => m.kind === "preference")
        .map((m) => m.text);
      const contacts = alive
        .filter(
          (m) =>
            m.kind === "contact" &&
            m.contact_email &&
            participantEmails.has(m.contact_email.toLowerCase()),
        )
        .map((m) => `${m.contact_email}: ${m.text}`);

      // Signature is a user pref on the shared client_state row.
      const state = account.user_id
        ? await ctx.db
            .query("client_state")
            .withIndex("by_user", (q) => q.eq("user_id", account.user_id))
            .unique()
        : null;

      return {
        account: { _id: account._id, name: account.name, email: account.email },
        subject: thread.subject,
        messages,
        style,
        preferences,
        contacts,
        signature: state?.signature ?? null,
      };
    }
    throw new Error("Thread not found");
  },
});

export function draftSystem(ctx2: {
  name?: string;
  email: string;
  style: string[];
  preferences: string[];
  contacts: string[];
  signature: string | null;
}): string {
  const who = ctx2.name ? `${ctx2.name} <${ctx2.email}>` : ctx2.email;
  const parts = [
    `You write email as ${who}. You ARE this person — the reply goes out under their name.`,
  ];
  if (ctx2.style.length > 0) {
    parts.push("How they write:", ...ctx2.style.map((s) => `- ${s}`));
  }
  if (ctx2.contacts.length > 0) {
    parts.push("About the people on this thread:", ...ctx2.contacts.map((s) => `- ${s}`));
  }
  if (ctx2.preferences.length > 0) {
    parts.push("Standing preferences:", ...ctx2.preferences.map((s) => `- ${s}`));
  }
  parts.push(
    "Rules:",
    "- Reply to the newest message, using the whole thread for context.",
    "- Plain text only. No subject line, no headers, no placeholders like [name].",
    "- Say only what the thread supports. Invent no facts, commitments, or dates.",
    "- Match their voice and typical length; when unsure, shorter.",
    ctx2.signature
      ? `- End with their signature:\n${ctx2.signature}`
      : "- Sign off the way they usually do.",
    "Output ONLY the reply body.",
  );
  return parts.join("\n");
}

