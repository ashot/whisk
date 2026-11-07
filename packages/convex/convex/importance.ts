import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { threadByGmailId } from "./lib/threads";
import { THREAD_WINDOW } from "./lib/rows";
import { isOwnAddress } from "@mail/shared/src/lib/sendAs";
import {
  importancePolicy,
  importanceRevision,
  type ImportancePrefs,
} from "@mail/shared/src/lib/importance";
import type { ImportanceCorrection } from "./ai/importance";

// Importance: the deterministic machinery around the judge in ai/actions.ts.
// The person's policy lives in their client prefs (it follows them across
// devices); verdicts land on thread rows and ride the thread delta channel.

type ReadCtx = { db: QueryCtx["db"] };

/** How many hand corrections the judge reads as examples, newest first. */
const CORRECTIONS = 30;

export async function importanceSettings(
  ctx: ReadCtx,
  account: Doc<"accounts"> | null,
): Promise<{ policy: string; revision: number }> {
  const state = account?.user_id
    ? await ctx.db
        .query("client_state")
        .withIndex("by_user", (q) => q.eq("user_id", account.user_id))
        .unique()
    : null;
  const prefs = (state?.prefs as { importance?: ImportancePrefs } | undefined)?.importance;
  return { policy: importancePolicy(prefs), revision: importanceRevision(prefs) };
}

/** Everything a judging pass needs besides the threads themselves. */
export const judgeContext = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const account = await ctx.db.get(accountId);
    const { policy, revision } = await importanceSettings(ctx, account);
    const corrections: ImportanceCorrection[] = [];
    for await (const t of ctx.db
      .query("threads")
      .withIndex("by_account_important_by", (q) => q.eq("account_id", accountId).eq("important_by", "user"))
      .order("desc")) {
      if (corrections.length >= CORRECTIONS) break;
      if (t.deleted || t.important === undefined) continue;
      const sender = t.participants.find((p) => !account || !isOwnAddress(account, p.email)) ?? t.participants[0];
      corrections.push({
        from: sender ? (sender.name ? `${sender.name} <${sender.email}>` : sender.email) : "",
        subject: t.subject.slice(0, 120),
        important: t.important,
      });
    }
    return { owner: account?.email ?? "", policy, revision, corrections };
  },
});

/** Land verdicts. A hand mark is final; a verdict read from an older policy
 *  or an older state of the thread is dropped (a newer pass covers it). */
export const applyImportance = internalMutation({
  args: {
    accountId: v.id("accounts"),
    revision: v.number(),
    verdicts: v.array(
      v.object({
        thread_gmail_id: v.string(),
        important: v.boolean(),
        why: v.string(),
        message_count: v.number(),
        last_at: v.number(),
      }),
    ),
  },
  handler: async (ctx, { accountId, revision, verdicts }) => {
    const account = await ctx.db.get(accountId);
    if (!account) return { applied: 0 };
    if ((await importanceSettings(ctx, account)).revision !== revision) return { applied: 0 };
    const now = Date.now();
    let applied = 0;
    for (const verdict of verdicts) {
      const t = await threadByGmailId(ctx, accountId, verdict.thread_gmail_id);
      if (!t || t.deleted || t.important_by === "user") continue;
      if (t.message_count !== verdict.message_count || t.last_at !== verdict.last_at) continue;
      if (t.important === verdict.important && t.important_why === verdict.why && t.important_by === "ai") continue;
      await ctx.db.patch(t._id, { important: verdict.important, important_by: "ai", important_why: verdict.why, updated_at: now });
      applied++;
    }
    return { applied };
  },
});

/** A hand mark: the named threads are the person's word. `important: null`
 *  hands a thread back to the model, which judges it again. */
export async function markImportance(
  ctx: { db: MutationCtx["db"]; scheduler: MutationCtx["scheduler"] },
  account: Doc<"accounts">,
  threadGmailIds: string[],
  important: boolean | null,
): Promise<{ marked: number }> {
  const now = Date.now();
  let marked = 0;
  for (const id of threadGmailIds) {
    const t = await threadByGmailId(ctx, account._id, id);
    if (!t || t.deleted) continue;
    await ctx.db.patch(t._id, important === null
      ? { important: undefined, important_by: undefined, important_why: undefined, updated_at: now }
      : { important, important_by: "user", important_why: undefined, updated_at: now });
    marked++;
  }
  if (important === null && marked > 0 && process.env.ANTHROPIC_API_KEY) {
    await ctx.scheduler.runAfter(0, internal.ai.actions.judgeImportance, { accountId: account._id, threadGmailIds });
  }
  return { marked };
}

/** Judge the recent inbox again, for every mailbox named. */
export async function scheduleInboxPass(
  ctx: { scheduler: MutationCtx["scheduler"] },
  accountIds: Id<"accounts">[],
  limit?: number,
): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return;
  for (const accountId of accountIds) {
    await ctx.scheduler.runAfter(0, internal.ai.actions.judgeImportance, { accountId, limit });
  }
}

/** Operator entry: judge the whole synced inbox of the named Gmail
 *  mailboxes (a first pass, or a pass after a prompt change), since mail
 *  nothing judged shows as important. Demo mailboxes are skipped.
 *  npx convex run importance:judgeInboxes '{"emails":["a@b.c"]}' */
export const judgeInboxes = internalMutation({
  args: { emails: v.array(v.string()) },
  handler: async (ctx, { emails }) => {
    const wanted = new Set(emails.map((e) => e.toLowerCase()));
    const accounts = (await ctx.db.query("accounts").collect()).filter((a) => a.provider === "gmail" && wanted.has(a.email.toLowerCase()));
    await scheduleInboxPass(ctx, accounts.map((a) => a._id), THREAD_WINDOW);
    return { scheduled: accounts.map((a) => a.email) };
  },
});
