import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { mailReader, threadForId } from "../lib/privacy";
import { DRAFT_FROM_THREAD } from "./draft";
import type { Id } from "../_generated/dataModel";
import { readableBody, transcriptOf } from "./mailText";
import { isOwnAddress } from "@mail/shared/src/lib/sendAs";

// Predicted replies for the empty composer. Same idea as Codecast's
// composer suggestions: an LLM sees the thread plus a corpus of the
// person's own sent mail, and guesses what they would type next — or
// nothing. The client shows the guesses as ghost text only while the
// box is empty; typing dismisses them.

export const MAX_SUGGESTIONS = 3;
export const MAX_SUGGESTION_CHARS = 1200;

export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.!?…]+$/, "").trim();
}

export function sanitizeSuggestions(parsed: unknown, bannedVerbatim: Set<string>): string[] {
  const rawList: unknown[] = Array.isArray(parsed) ? parsed : [];
  const seen = new Set<string>();
  const scored: Array<{ text: string; conf: number }> = [];
  for (const item of rawList) {
    const text = (typeof item === "string" ? item : (item as { text?: unknown })?.text)
      ?.toString()
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "");
    if (!text || text.length > MAX_SUGGESTION_CHARS) continue;
    if (/^(i cannot|i can't|i'm sorry|sorry|as an ai)/i.test(text)) continue;
    const key = normalizeForMatch(text);
    if (!key || seen.has(key) || bannedVerbatim.has(key)) continue;
    seen.add(key);
    const rawConf = (item as { confidence?: unknown })?.confidence;
    const conf = typeof rawConf === "number" && rawConf >= 0 && rawConf <= 1 ? rawConf : 0.75;
    scored.push({ text, conf });
  }
  const kept = scored.filter((s) => s.conf >= 0.7).sort((a, b) => b.conf - a.conf);
  return kept.slice(0, MAX_SUGGESTIONS).map((s) => s.text);
}

export function buildSuggestPrompt(input: {
  who: string;
  subject: string;
  transcript: string;
  sent: string[];
  style: string[];
  preferences: string[];
  contacts: string[];
  signature: string | null;
}): string {
  const habits = input.style.length
    ? input.style.map((s) => `- ${s}`).join("\n")
    : "- none stored";
  const prefs = input.preferences.length
    ? input.preferences.map((s) => `- ${s}`).join("\n")
    : "- none stored";
  const people = input.contacts.length
    ? input.contacts.map((s) => `- ${s}`).join("\n")
    : "- none stored";
  const sent = input.sent.length
    ? input.sent.map((t) => `- ${t.length > 400 ? t.slice(0, 400) + " […]" : t}`).join("\n")
    : "- none yet";
  const sign = input.signature
    ? `End the way they do:\n${input.signature}`
    : "Sign off the way their sent mail does.";

  return `You predict what ${input.who} will type as their next email reply. You see this thread, plus how they actually write — stored habits and a sample of their own sent mail. Your job is to apply those habits to THIS thread and produce the exact next message they would send, or nothing.

Return ONLY a JSON array: [{"text": string, "confidence": number}] — 0 to 3 entries. "confidence" is the probability (0..1) they would actually send this text or a trivial variant. Omit anything below 0.7. No wrapper, no markdown, no commentary. [] is the right answer when the next message is not predictable.

The test for every suggestion: they read it and think "I was just about to type that." You are predicting what THEY would type, not a sensible reply in the abstract. A good email they would never have written is a miss.

Calibrate: most next emails are not predictable. A confidence of 0.7 claims this is one of the rare ones. When the inbound asks for a fact, a date, a file, or a decision only they hold, return []. Never invent commitments.

Voice: copy their register from the sent mail — casing, punctuation, length, sign-off. Every suggestion must be sendable as written, about THIS thread. Never replay a past email verbatim: those are other conversations. Apply the TENDENCY (short, warm, asks one question, etc.) to what is on the table now.

${sign}

Subject: ${input.subject}

How they write:
${habits}

Standing preferences:
${prefs}

People on this thread:
${people}

Their recent sent mail (voice evidence, not to copy):
${sent}

Thread:
${input.transcript}`;
}

export type SuggestContext =
  | { skip: true; reason: string }
  | {
      skip: false;
      account_id: Id<"accounts">;
      who: string;
      email: string;
      subject: string;
      transcript: string;
      sent: string[];
      style: string[];
      preferences: string[];
      contacts: string[];
      signature: string | null;
      anchor: string;
    };

export const contextForSuggest = internalQuery({
  args: {
    token: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
    threadGmailId: v.string(),
  },
  handler: async (ctx, { token, accountId, threadGmailId }): Promise<SuggestContext> => {
    const reader = await mailReader(ctx, token, DRAFT_FROM_THREAD, accountId);
    const accounts = reader.accounts;

    for (const account of accounts) {
      const thread = await ctx.db
        .query("threads")
        .withIndex("by_account_gmail", (q) =>
          q.eq("account_id", account._id).eq("gmail_id", threadGmailId),
        )
        .unique();
      if (!thread || thread.deleted || !reader.sees(thread)) continue;

      const rows = await ctx.db
        .query("messages")
        .withIndex("by_account_thread", (q) =>
          q.eq("account_id", account._id).eq("thread_gmail_id", threadGmailId),
        )
        .order("asc")
        .collect();
      const messages = rows.filter((m) => !m.deleted);
      const last = messages[messages.length - 1];
      // Nothing to reply to if they spoke last.
      if (!last || isOwnAddress(account, last.from.email)) {
        return { skip: true as const, reason: "no_inbound_tail" };
      }

      const memoryRows = await ctx.db
        .query("memories")
        .withIndex("by_account", (q) => q.eq("account_id", account._id))
        .collect();
      const alive = memoryRows.filter((m) => !m.deleted);
      const participantEmails = new Set(
        thread.participants.map((p) => p.email.toLowerCase()),
      );
      const style = alive.filter((m) => m.kind === "style").map((m) => m.text);
      const preferences = alive.filter((m) => m.kind === "preference").map((m) => m.text);
      const contacts = alive
        .filter(
          (m) =>
            m.kind === "contact" &&
            m.contact_email &&
            participantEmails.has(m.contact_email.toLowerCase()),
        )
        .map((m) => `${m.contact_email}: ${m.text}`);

      const recent = await ctx.db
        .query("messages")
        .withIndex("by_account_updated", (q) => q.eq("account_id", account._id))
        .order("desc")
        .take(120);
      const sent: string[] = [];
      const seen = new Set<string>();
      for (const m of recent) {
        if (m.deleted) continue;
        const mine = isOwnAddress(account, m.from.email) || m.label_ids.includes("SENT");
        if (!mine) continue;
        // Sent mail is shown as examples of the person's voice; none of it
        // may come from a thread the reader cannot see.
        if (reader.hidesPrivate) {
          const home = await threadForId(ctx, account._id, m.thread_gmail_id);
          if (home && !reader.sees(home)) continue;
        }
        const text = readableBody(m, 600);
        const key = normalizeForMatch(text);
        if (!text || seen.has(key)) continue;
        seen.add(key);
        sent.push(text);
        if (sent.length >= 20) break;
      }

      const state = account.user_id
        ? await ctx.db
            .query("client_state")
            .withIndex("by_user", (q) => q.eq("user_id", account.user_id))
            .unique()
        : null;

      return {
        skip: false as const,
        account_id: account._id,
        who: account.name ? `${account.name} <${account.email}>` : account.email,
        email: account.email,
        subject: thread.subject,
        transcript: transcriptOf(
          messages.map((m) => ({
            from: m.from,
            date: m.date,
            body_text: m.body_text,
            snippet: m.snippet,
          })),
        ),
        sent,
        style,
        preferences,
        contacts,
        signature: state?.signature ?? null,
        anchor: last.gmail_id,
      };
    }
    throw new Error("Thread not found");
  },
});
