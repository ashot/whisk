"use node";

import { v } from "convex/values";
import { action, internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { actionAccounts } from "../lib/actionAuth";
import { PRIVACY_MODEL, aiConfigured, completeJson } from "./llm";
import { PRIVACY_BATCH, PRIVACY_SYSTEM, parsePrivacyVerdict, privacyInput, type JudgedRule, type PrivacyView } from "./privacyJudge";
import { MAX_PRIVACY_RULE, ruleKey, type PrivacyRule } from "@mail/shared/src/lib/privacy";

// Model calls for private mail. Data access stays in privacy.ts; this file
// reads what it is handed, asks the model, and hands verdicts back.

const CONCURRENCY = 4;

/** One judging call: which of `rules` each thread falls under. Throws on an
 *  answer it cannot trust. */
async function judgeBatch(owner: string, rules: JudgedRule[], views: PrivacyView[]) {
  const raw = await completeJson<unknown>({
    model: PRIVACY_MODEL,
    system: PRIVACY_SYSTEM,
    user: privacyInput(owner, rules, views),
    maxTokens: 3000,
    effort: "low",
    timeoutMs: 60_000,
  });
  return parsePrivacyVerdict(raw, views.length, rules.length);
}

/** Run `work` over items at most CONCURRENCY at a time; a failure is logged
 *  and leaves its items as they were (hidden from agents, read again later). */
async function inWaves<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        try {
          await work(item);
        } catch (error) {
          console.error("Privacy check failed", error);
        }
      }
    }),
  );
}

/**
 * Read threads against the person's privacy rules and land the verdicts.
 * With ids: those threads (new mail, a search hit, a mark handed back).
 * Without: the mailbox's window newest first, a run at a time, each run
 * scheduling the next until the window is current. A run started under
 * rules that have since changed stops; the change scheduled its own pass.
 */
export const judgePrivacy = internalAction({
  args: {
    accountId: v.id("accounts"),
    threadGmailIds: v.optional(v.array(v.string())),
    before: v.optional(v.number()),
    scanned: v.optional(v.number()),
    digest: v.optional(v.string()),
  },
  handler: async (ctx, { accountId, threadGmailIds, before, scanned, digest }): Promise<{ applied: number }> => {
    if (!aiConfigured()) return { applied: 0 };
    const work = await ctx.runQuery(internal.privacy.privacyWork, { accountId, threadGmailIds, before, scanned });
    if (digest !== undefined && work.digest !== digest) return { applied: 0 };
    const byId = new Map(work.rules.map((r) => [r.id, r]));
    const batches: (typeof work.work)[] = [];
    for (let i = 0; i < work.work.length; i += PRIVACY_BATCH) batches.push(work.work.slice(i, i + PRIVACY_BATCH));
    let applied = 0;
    await inWaves(batches, async (batch) => {
      const views: PrivacyView[] = await ctx.runQuery(internal.privacy.privacyViews, {
        accountId,
        threadGmailIds: batch.map((w) => w.gmail_id),
      });
      if (views.length === 0) return;
      // Every rule any thread in the batch still needs; reading a thread
      // against a rule it already passed again is harmless.
      const ids = [...new Set(batch.flatMap((w) => w.rule_ids))];
      const rules = ids.map((id) => byId.get(id)).filter((r): r is PrivacyRule => !!r);
      const verdicts = await judgeBatch(work.owner, rules, views);
      const result: { applied: number } = await ctx.runMutation(internal.privacy.applyVerdicts, {
        accountId,
        results: views.map((view, i) => ({
          thread_gmail_id: view.gmail_id,
          message_count: view.message_count,
          checked: rules.map(ruleKey),
          hits: verdicts[i].rules.map((r) => rules[r].id),
          why: verdicts[i].why,
        })),
      });
      applied += result.applied;
    });
    if (work.before !== null) {
      await ctx.scheduler.runAfter(0, internal.ai.privacy.judgePrivacy, {
        accountId,
        before: work.before,
        scanned: work.scanned,
        digest: work.digest,
      });
    }
    return { applied };
  },
});

/** Dry run of a rule over each mailbox's recent mail: the threads it would
 *  make private and why. Nothing changes. The person's own sessions only:
 *  it reads private mail to answer. */
export const previewPrivacy = action({
  args: { token: v.optional(v.string()), text: v.string(), limit: v.optional(v.number()) },
  handler: async (
    ctx,
    { token, text, limit },
  ): Promise<Array<{ account_id: Id<"accounts">; thread_gmail_id: string; subject: string; from: string; why: string }>> => {
    const accounts = await actionAccounts(ctx, { token, scope: [] });
    if (accounts.length === 0) throw new Error("Unauthorized: no connected accounts");
    if (!aiConfigured()) throw new Error("AI is not configured on this deployment");
    const rule = text.trim();
    if (!rule || rule.length > MAX_PRIVACY_RULE) throw new Error(`Describe it in at most ${MAX_PRIVACY_RULE} characters`);
    const per = Math.max(10, Math.min(limit ?? 100, 200));
    const out: Array<{ account_id: Id<"accounts">; thread_gmail_id: string; subject: string; from: string; why: string }> = [];
    for (const account of accounts) {
      await ctx.runMutation(internal.ai.filterSupport.takeModelBudget, { accountId: account._id, cost: Math.ceil(per / PRIVACY_BATCH) });
      out.push(...(await previewAccount(ctx, account._id, rule, per)));
    }
    return out;
  },
});

async function previewAccount(ctx: ActionCtx, accountId: Id<"accounts">, text: string, limit: number) {
  const { owner, ids }: { owner: string; ids: string[] } = await ctx.runQuery(internal.privacy.recentIds, { accountId, limit });
  const hits: Array<{ account_id: Id<"accounts">; thread_gmail_id: string; subject: string; from: string; why: string }> = [];
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += PRIVACY_BATCH) batches.push(ids.slice(i, i + PRIVACY_BATCH));
  await inWaves(batches, async (batch) => {
    const views: PrivacyView[] = await ctx.runQuery(internal.privacy.privacyViews, { accountId, threadGmailIds: batch });
    if (views.length === 0) return;
    const verdicts = await judgeBatch(owner, [{ id: "draft", text }], views);
    views.forEach((view, i) => {
      if (verdicts[i].rules.length > 0) {
        hits.push({ account_id: accountId, thread_gmail_id: view.gmail_id, subject: view.subject, from: view.from, why: verdicts[i].why ?? "" });
      }
    });
  });
  const order = new Map(ids.map((id, i) => [id, i]));
  return hits.sort((a, b) => order.get(a.thread_gmail_id)! - order.get(b.thread_gmail_id)!);
}
