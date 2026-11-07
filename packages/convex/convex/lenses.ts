import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { threadByGmailId } from "./lib/threads";
import { THREAD_WINDOW } from "./lib/rows";
import { isOwnAddress } from "@mail/shared/src/lib/sendAs";
import { lensPolicy, lensesFromPrefs, type Lens } from "@mail/shared/src/lib/lenses";
import type { JudgedLens, LensCorrection } from "./ai/lenses";

// Lenses: the deterministic machinery around the judge in ai/actions.ts.
// The lenses live in the person's client prefs (they follow them across
// devices); scores land on thread rows and ride the thread delta channel.

type ReadCtx = { db: QueryCtx["db"] };
type SchedCtx = { scheduler: MutationCtx["scheduler"] };

/** How many recent hand placements the judge reads as examples. */
const CORRECTIONS = 40;

export async function lensSettings(ctx: ReadCtx, account: Doc<"accounts"> | null): Promise<Lens[]> {
  const state = account?.user_id
    ? await ctx.db.query("client_state").withIndex("by_user", (q) => q.eq("user_id", account.user_id)).unique()
    : null;
  return lensesFromPrefs(state?.prefs as Parameters<typeof lensesFromPrefs>[0]);
}

/** Everything a judging pass needs besides the threads: the lenses to score
 *  (all, or the named ones) with their revisions, and recent placements. */
export const judgeContext = internalQuery({
  args: { accountId: v.id("accounts"), lensIds: v.optional(v.array(v.string())) },
  handler: async (ctx, { accountId, lensIds }) => {
    const account = await ctx.db.get(accountId);
    const wanted = lensIds ? new Set(lensIds) : null;
    const lenses = (await lensSettings(ctx, account)).filter((l) => (!wanted || wanted.has(l.id)) && lensPolicy(l));
    const judged: Array<JudgedLens & { revision: number }> = lenses.map((l) => ({ id: l.id, name: l.name, policy: lensPolicy(l), revision: l.revision }));
    const corrections: LensCorrection[] = [];
    for await (const t of ctx.db
      .query("threads")
      .withIndex("by_account_marked", (q) => q.eq("account_id", accountId).gt("marked_at", 0))
      .order("desc")) {
      if (corrections.length >= CORRECTIONS) break;
      if (t.deleted || !t.lens_marks) continue;
      const sender = t.participants.find((p) => !account || !isOwnAddress(account, p.email)) ?? t.participants[0];
      const from = sender ? (sender.name ? `${sender.name} <${sender.email}>` : sender.email) : "";
      for (const [lens, belongs] of Object.entries(t.lens_marks)) corrections.push({ from, subject: t.subject.slice(0, 120), lens, belongs });
    }
    return { owner: account?.email ?? "", lenses: judged, corrections };
  },
});

/** Land scores. Each lens's scores land only if its description has not
 *  changed since the read; a thread that moved on since is skipped (a newer
 *  pass covers it). Scores for lenses that no longer exist are dropped. */
export const applyScores = internalMutation({
  args: {
    accountId: v.id("accounts"),
    revisions: v.record(v.string(), v.number()),
    results: v.array(
      v.object({
        thread_gmail_id: v.string(),
        message_count: v.number(),
        last_at: v.number(),
        scores: v.record(v.string(), v.object({ score: v.number(), why: v.string() })),
      }),
    ),
  },
  handler: async (ctx, { accountId, revisions, results }) => {
    const account = await ctx.db.get(accountId);
    if (!account) return { applied: 0 };
    const current = new Map((await lensSettings(ctx, account)).map((l) => [l.id, l.revision]));
    const fresh = Object.keys(revisions).filter((id) => current.get(id) === revisions[id]);
    if (fresh.length === 0) return { applied: 0 };
    const now = Date.now();
    let applied = 0;
    for (const r of results) {
      const t = await threadByGmailId(ctx, accountId, r.thread_gmail_id);
      if (!t || t.deleted || t.message_count !== r.message_count || t.last_at !== r.last_at) continue;
      const scores: Record<string, number> = {};
      const why: Record<string, string> = {};
      for (const [id, s] of Object.entries(t.lens_scores ?? {})) if (current.has(id)) scores[id] = s;
      for (const [id, w] of Object.entries(t.lens_why ?? {})) if (current.has(id)) why[id] = w;
      for (const id of fresh) {
        const s = r.scores[id];
        if (!s) continue;
        scores[id] = s.score;
        why[id] = s.why;
      }
      if (sameRecord(scores, t.lens_scores) && sameRecord(why, t.lens_why)) continue;
      await ctx.db.patch(t._id, { lens_scores: scores, lens_why: why, updated_at: now });
      applied++;
    }
    return { applied };
  },
});

function sameRecord<T>(a: Record<string, T>, b: Record<string, T> | undefined): boolean {
  const keys = Object.keys(a);
  return !!b && keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** A hand placement: the named threads belong in a lens or do not, by the
 *  person's word. `belongs: null` hands them back to the model. */
export async function markLens(
  ctx: { db: MutationCtx["db"] } & SchedCtx,
  account: Doc<"accounts">,
  threadGmailIds: string[],
  lensId: string,
  belongs: boolean | null,
): Promise<{ marked: number }> {
  const now = Date.now();
  let marked = 0;
  for (const id of threadGmailIds) {
    const t = await threadByGmailId(ctx, account._id, id);
    if (!t || t.deleted) continue;
    const marks = { ...(t.lens_marks ?? {}) };
    if (belongs === null) delete marks[lensId];
    else marks[lensId] = belongs;
    const any = Object.keys(marks).length > 0;
    await ctx.db.patch(t._id, { lens_marks: any ? marks : undefined, marked_at: any ? now : undefined, updated_at: now });
    marked++;
  }
  if (belongs === null && marked > 0) await scheduleLensPass(ctx, [account._id], { threadGmailIds, lensIds: [lensId] });
  return { marked };
}

/** Judge mail again for the named mailboxes: the given threads, else the
 *  newest `limit` in the inbox; every lens, else the named ones. */
export async function scheduleLensPass(
  ctx: SchedCtx,
  accountIds: Id<"accounts">[],
  opts: { threadGmailIds?: string[]; lensIds?: string[]; limit?: number } = {},
): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return;
  for (const accountId of accountIds) {
    await ctx.scheduler.runAfter(0, internal.ai.actions.judgeLenses, { accountId, ...opts });
  }
}

/** Operator entry: judge the whole synced inbox of the named Gmail mailboxes
 *  on every lens (a first pass, or after a prompt change). Demo mailboxes
 *  are skipped.
 *  npx convex run lenses:judgeInboxes '{"emails":["a@b.c"]}' */
export const judgeInboxes = internalMutation({
  args: { emails: v.array(v.string()) },
  handler: async (ctx, { emails }) => {
    const wanted = new Set(emails.map((e) => e.toLowerCase()));
    const accounts = (await ctx.db.query("accounts").collect()).filter((a) => a.provider === "gmail" && wanted.has(a.email.toLowerCase()));
    await scheduleLensPass(ctx, accounts.map((a) => a._id), { limit: THREAD_WINDOW });
    return { scheduled: accounts.map((a) => a.email) };
  },
});
