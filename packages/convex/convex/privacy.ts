import { v } from "convex/values";
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { THREAD_WINDOW } from "./lib/rows";
import { mailReader, privacyRulesForUser } from "./lib/privacy";
import { readableBody } from "./ai/mailText";
import { PRIVACY_BATCH, type PrivacyView } from "./ai/privacyJudge";
import { isOwnAddress } from "@mail/shared/src/lib/sendAs";
import {
  ruleKey,
  rulesToCheck,
  threadPrivacy,
  type PrivacyRule,
} from "@mail/shared/src/lib/privacy";

// Private mail: the deterministic machinery around the privacy judge in
// ai/privacy.ts. The rules live in the person's prefs (they follow them
// across devices and edit offline like any pref); verdicts land on thread
// rows and ride the thread delta channel to the app. What a reader kept
// from private mail may see is decided in lib/privacy, from these fields.

type ReadCtx = { db: QueryCtx["db"] };
type SchedCtx = { scheduler: MutationCtx["scheduler"] };

/** Threads one pass run takes before it hands the rest to a fresh run, so
 *  a whole window never sits in one action. */
export const PRIVACY_RUN = 120;
/** Messages of a thread the judge reads (the newest, plus the first), and
 *  how much of each. */
const VIEW_MESSAGES = 4;
const VIEW_CHARS = 700;

/** One digest of the rule wordings in force, so a pass started under other
 *  rules can tell it is stale and stop. */
export function rulesDigest(rules: readonly PrivacyRule[]): string {
  return rules.map(ruleKey).sort().join(",");
}

async function rulesForAccount(ctx: ReadCtx, accountId: Id<"accounts">): Promise<{ account: Doc<"accounts"> | null; rules: PrivacyRule[] }> {
  const account = await ctx.db.get(accountId);
  return { account, rules: await privacyRulesForUser(ctx, account?.user_id) };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Read every thread in each mailbox's window that needs it against the
 *  rules (after a rule is added or reworded). */
export async function schedulePrivacyPass(ctx: SchedCtx, accountIds: Id<"accounts">[]): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return;
  for (const accountId of accountIds) {
    await ctx.scheduler.runAfter(0, internal.ai.privacy.judgePrivacy, { accountId });
  }
}

/** New mail, or a mark handed back to the rules: read these threads again
 *  when the person has rules and any of them needs it. Cheap when nothing
 *  does, so the sync path calls it on every apply. */
export async function schedulePrivacyCheck(
  ctx: ReadCtx & SchedCtx,
  accountId: Id<"accounts">,
  threadGmailIds: string[],
): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY || threadGmailIds.length === 0) return;
  const { rules } = await rulesForAccount(ctx, accountId);
  if (rules.length === 0) return;
  const stale: string[] = [];
  for (const id of threadGmailIds) {
    const t = await threadRow(ctx, accountId, id);
    if (t && !t.deleted && t.message_count > 0 && rulesToCheck(t, rules).length > 0) stale.push(id);
  }
  if (stale.length > 0) {
    await ctx.scheduler.runAfter(0, internal.ai.privacy.judgePrivacy, { accountId, threadGmailIds: stale });
  }
}

async function threadRow(ctx: ReadCtx, accountId: Id<"accounts">, gmailId: string): Promise<Doc<"threads"> | null> {
  return await ctx.db
    .query("threads")
    .withIndex("by_account_gmail", (q) => q.eq("account_id", accountId).eq("gmail_id", gmailId))
    .unique();
}

// ---------------------------------------------------------------------------
// What the judge reads
// ---------------------------------------------------------------------------

/**
 * The threads a pass should read next: the named ones, else the window
 * newest first from `before` (a last_at cursor), each with the rules it
 * still needs. Hand-marked threads and ones already current are skipped.
 */
export const privacyWork = internalQuery({
  args: {
    accountId: v.id("accounts"),
    threadGmailIds: v.optional(v.array(v.string())),
    before: v.optional(v.number()),
    scanned: v.optional(v.number()),
  },
  handler: async (ctx, { accountId, threadGmailIds, before, scanned = 0 }) => {
    const { account, rules } = await rulesForAccount(ctx, accountId);
    const work: Array<{ gmail_id: string; rule_ids: string[] }> = [];
    const empty = { owner: account?.email ?? "", rules, digest: rulesDigest(rules), work, before: null as number | null, scanned };
    if (!account || rules.length === 0) return empty;
    const consider = (t: Doc<"threads"> | null) => {
      if (!t || t.deleted || t.message_count === 0) return;
      const need = rulesToCheck(t, rules);
      if (need.length > 0) work.push({ gmail_id: t.gmail_id, rule_ids: need.map((r) => r.id) });
    };
    if (threadGmailIds) {
      for (const id of threadGmailIds.slice(0, PRIVACY_RUN)) consider(await threadRow(ctx, accountId, id));
      return { ...empty, work };
    }
    let next: number | null = null;
    for await (const t of ctx.db
      .query("threads")
      .withIndex("by_account_last", (q) => (before === undefined ? q.eq("account_id", accountId) : q.eq("account_id", accountId).lt("last_at", before)))
      .order("desc")) {
      if (scanned >= THREAD_WINDOW) break;
      scanned++;
      consider(t);
      if (work.length >= PRIVACY_RUN) {
        next = t.last_at;
        break;
      }
    }
    return { ...empty, work, before: next, scanned };
  },
});

/** What the judge is shown of each thread: who is in it, its subject and
 *  lane, the names of its files, and the readable text of its newest few
 *  messages, the person's own included (a thread can turn private in any
 *  message, in either direction). */
export const privacyViews = internalQuery({
  args: { accountId: v.id("accounts"), threadGmailIds: v.array(v.string()) },
  handler: async (ctx, { accountId, threadGmailIds }): Promise<PrivacyView[]> => {
    const account = await ctx.db.get(accountId);
    const out: PrivacyView[] = [];
    for (const id of threadGmailIds.slice(0, PRIVACY_BATCH * 2)) {
      const t = await threadRow(ctx, accountId, id);
      if (!t || t.deleted) continue;
      // The first message (it often says what the thread is about, and
      // scrolls out of a long thread first) and the newest few.
      const newest: Doc<"messages">[] = [];
      for await (const m of ctx.db
        .query("messages")
        .withIndex("by_account_thread", (q) => q.eq("account_id", accountId).eq("thread_gmail_id", id))
        .order("desc")) {
        if (m.deleted) continue;
        newest.push(m);
        if (newest.length >= VIEW_MESSAGES) break;
      }
      let first: Doc<"messages"> | null = null;
      if (newest.length >= VIEW_MESSAGES) {
        for await (const m of ctx.db
          .query("messages")
          .withIndex("by_account_thread", (q) => q.eq("account_id", accountId).eq("thread_gmail_id", id))
          .order("asc")) {
          if (!m.deleted) { first = m; break; }
        }
      }
      const messages = newest.reverse();
      if (first && !messages.some((m) => m._id === first!._id)) messages.unshift(first);
      const name = (a: { name?: string; email: string }) => (a.name ? `${a.name} <${a.email}>` : a.email);
      const inbound = [...messages].reverse().find((m) => !account || !isOwnAddress(account, m.from.email)) ?? messages[messages.length - 1];
      out.push({
        gmail_id: t.gmail_id,
        message_count: t.message_count,
        from: inbound ? name(inbound.from) : t.participants.map(name).join(", "),
        to: t.participants.map((p) => p.email).join(", ").slice(0, 200),
        subject: t.subject.slice(0, 160),
        lane: t.category ?? "primary",
        attachments: messages.flatMap((m) => m.attachments.map((a) => a.filename)).slice(0, 10),
        messages: messages.map((m) => ({ from: name(m.from), body: readableBody(m, VIEW_CHARS) })),
      });
    }
    return out;
  },
});

/**
 * Land verdicts. A verdict counts only for rules still worded as they were
 * when it was read, and only if the thread has not changed since (a newer
 * read covers it). Earlier reads against other rules stand while the
 * thread's messages are the same; new messages start the record over.
 */
export const applyVerdicts = internalMutation({
  args: {
    accountId: v.id("accounts"),
    results: v.array(
      v.object({
        thread_gmail_id: v.string(),
        message_count: v.number(),
        /** Rule keys this read covered. */
        checked: v.array(v.string()),
        /** Rule ids among them the thread falls under. */
        hits: v.array(v.string()),
        why: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { accountId, results }) => {
    const { rules } = await rulesForAccount(ctx, accountId);
    const current = new Map(rules.map((r) => [ruleKey(r), r.id]));
    const now = Date.now();
    let applied = 0;
    for (const r of results) {
      const t = await threadRow(ctx, accountId, r.thread_gmail_id);
      if (!t || t.deleted || t.message_count !== r.message_count) continue;
      const checkedNow = r.checked.filter((k) => current.has(k));
      if (checkedNow.length === 0) continue;
      const judgedIds = new Set(checkedNow.map((k) => current.get(k)!));
      const same = t.private_count === t.message_count;
      const liveKeys = new Set(current.keys());
      const liveIds = new Set(current.values());
      // A hit is sticky: once a thread fell under a rule at its current
      // wording, new mail never opens it again (the judge sees only part of
      // a long thread). Rewording the rule, or the person's hand, does.
      const priorKeys = new Set(t.private_checked ?? []);
      const sticky = (t.private_hits ?? []).filter((id) => rules.some((r) => r.id === id && priorKeys.has(ruleKey(r))));
      const checked = [...new Set([...(same ? (t.private_checked ?? []).filter((k) => liveKeys.has(k)) : []), ...sticky.map((id) => ruleKey(rules.find((r) => r.id === id)!)), ...checkedNow])].sort();
      const kept = [...sticky, ...(same ? (t.private_hits ?? []).filter((id) => liveIds.has(id) && !judgedIds.has(id)) : [])];
      const hits = [...new Set([...kept, ...r.hits.filter((id) => judgedIds.has(id))])].sort();
      const why = hits.length > 0 ? (r.hits.length > 0 ? r.why?.slice(0, 120) : t.private_why) : undefined;
      await ctx.db.patch(t._id, {
        private_checked: checked,
        private_hits: hits.length > 0 ? hits : undefined,
        private_count: t.message_count,
        private_why: why,
        updated_at: now,
      });
      applied++;
    }
    return { applied };
  },
});

/** Which of these threads the caller may see: all of them for the person,
 *  the open ones for a login kept from private mail. Dry runs of filters
 *  and views read mail on the caller's behalf, so they ask first. */
export const visibleIds = internalQuery({
  args: { token: v.optional(v.string()), accountId: v.id("accounts"), gmailIds: v.array(v.string()) },
  handler: async (ctx, { token, accountId, gmailIds }) => {
    const reader = await mailReader(ctx, token, "mail.read", accountId);
    if (!reader.hidesPrivate) return gmailIds;
    const out: string[] = [];
    for (const id of gmailIds) {
      const t = await threadRow(ctx, accountId, id);
      if (t && !t.deleted && reader.sees(t)) out.push(id);
    }
    return out;
  },
});

/** The newest threads of a mailbox's window, for a dry run of a rule. */
export const recentIds = internalQuery({
  args: { accountId: v.id("accounts"), limit: v.number() },
  handler: async (ctx, { accountId, limit }) => {
    const account = await ctx.db.get(accountId);
    const ids: string[] = [];
    for await (const t of ctx.db
      .query("threads")
      .withIndex("by_account_last", (q) => q.eq("account_id", accountId))
      .order("desc")) {
      if (ids.length >= Math.min(limit, THREAD_WINDOW)) break;
      if (t.deleted || t.message_count === 0 || t.label_ids.includes("SPAM") || t.label_ids.includes("TRASH")) continue;
      ids.push(t.gmail_id);
    }
    return { owner: account?.email ?? "", ids };
  },
});

// ---------------------------------------------------------------------------
// Hand marks
// ---------------------------------------------------------------------------

/** The person's word on threads: private, not private, or (null) back to
 *  the rules, which reads them again. Final over any rule. */
export async function markPrivate(
  ctx: { db: MutationCtx["db"] } & SchedCtx,
  account: Doc<"accounts">,
  threadGmailIds: string[],
  mark: boolean | null,
): Promise<{ marked: number }> {
  const now = Date.now();
  const touched: string[] = [];
  for (const id of threadGmailIds.slice(0, 500)) {
    const t = await threadRow(ctx, account._id, id);
    if (!t || t.deleted) continue;
    if ((t.private_mark ?? null) === mark) continue;
    await ctx.db.patch(t._id, { private_mark: mark ?? undefined, updated_at: now });
    touched.push(id);
  }
  if (mark === null) await schedulePrivacyCheck(ctx, account._id, touched);
  return { marked: touched.length };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Where private mail stands, for whoever asks. The person's own sessions get
 * the counts per rule; a login kept from private mail learns only that it
 * is, and how many threads in the window it cannot see (so an agent can say
 * "some of your mail is private to you" instead of "nothing found").
 */
export const status = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const reader = await mailReader(ctx, token);
    const rules = reader.hidesPrivate ? reader.rules : await privacyRulesForUser(ctx, reader.accounts[0]?.user_id);
    let privateCount = 0;
    let pending = 0;
    let marked = 0;
    const perRule = new Map<string, number>();
    for (const account of reader.accounts) {
      for (const t of await ctx.db
        .query("threads")
        .withIndex("by_account_last", (q) => q.eq("account_id", account._id))
        .order("desc")
        .take(THREAD_WINDOW)) {
        if (t.deleted || t.message_count === 0) continue;
        const state = threadPrivacy(t, rules);
        if (state === "pending") pending++;
        if (state !== "private") continue;
        privateCount++;
        if (t.private_mark) marked++;
        else for (const id of t.private_hits ?? []) perRule.set(id, (perRule.get(id) ?? 0) + 1);
      }
    }
    if (reader.hidesPrivate) {
      return { hides_private: true as const, hidden: privateCount + pending, checking: pending };
    }
    return {
      hides_private: false as const,
      private: privateCount,
      pending,
      marked,
      rules: rules.map((r) => ({ id: r.id, text: r.text, threads: perRule.get(r.id) ?? 0 })),
      ai_configured: !!process.env.ANTHROPIC_API_KEY,
    };
  },
});
