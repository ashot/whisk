import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { mailReader, privacyRulesForUser, seesId } from "./lib/privacy";
import { threadPrivacy } from "@mail/shared/src/lib/privacy";
import { sanitizeCategory } from "./lib/categorize";
import { SYSTEM_LABEL_IDS, threadByGmailId } from "./lib/threads";
import { modifyThreadLabels, schedulePump } from "./lib/outbound";
import { readableBody } from "./ai/mailText";
import { THREAD_WINDOW } from "./lib/rows";
import { ensureCluster, placeThreads } from "./clusters";
import { isOwnAddress } from "@mail/shared/src/lib/sendAs";

// Natural-language filters: the read side, what the model judges against,
// and what a hit does. Parsing a sentence into a condition + actions and
// judging threads against conditions are model calls in ai/actions.ts; this
// file is the deterministic machinery on both sides of them.

/** Read side of a ctx: queries and mutations both qualify. */
type ReadCtx = { db: QueryCtx["db"] };

export const FILTER_ACTION_KINDS = [
  "archive",
  "trash",
  "star",
  "read",
  "label",
  "lane",
  "cluster",
] as const;
export type FilterActionKind = (typeof FILTER_ACTION_KINDS)[number];
export type FilterAction = { kind: FilterActionKind; arg?: string };

export const filterActionValidator = v.object({
  kind: v.union(...FILTER_ACTION_KINDS.map((k) => v.literal(k))),
  arg: v.optional(v.string()),
});

export const listFilters = query({
  args: { token: v.optional(v.string()), since: v.optional(v.number()) },
  handler: async (ctx, { token, since }) => {
    const reader = await mailReader(ctx, token);
    const out = [];
    for (const account of reader.accounts) {
      const rows = await ctx.db
        .query("filters")
        .withIndex("by_account", (q) =>
          since === undefined
            ? q.eq("account_id", account._id)
            : q.eq("account_id", account._id).gt("updated_at", since),
        )
        .collect();
      for (const row of rows) {
        // What a filter did lists subjects; a reader kept from private mail
        // gets the entries it could see.
        const recent = [];
        for (const r of row.recent) {
          if (await seesId(ctx, reader, account._id, r.thread_gmail_id)) recent.push(r);
        }
        out.push(recent.length === row.recent.length ? row : { ...row, recent });
      }
    }
    return out;
  },
});

export async function liveFilters(
  ctx: ReadCtx,
  accountId: Id<"accounts">,
): Promise<Doc<"filters">[]> {
  const rows = await ctx.db
    .query("filters")
    .withIndex("by_account", (q) => q.eq("account_id", accountId))
    .collect();
  return rows.filter((f) => !f.deleted);
}

/** Cheap gate for the sync path: is there any filter to judge against? */
export async function hasEnabledFilters(
  ctx: ReadCtx,
  accountId: Id<"accounts">,
): Promise<boolean> {
  return (await liveFilters(ctx, accountId)).some((f) => f.enabled);
}

/** The enabled filters the judge reads: id + condition only. */
export const enabledFilters = internalQuery({
  args: { accountId: v.id("accounts"), only: v.optional(v.array(v.id("filters"))) },
  handler: async (ctx, { accountId, only }) => {
    const wanted = only ? new Set(only.map(String)) : null;
    return (await liveFilters(ctx, accountId))
      .filter((f) => f.enabled && (!wanted || wanted.has(f._id)))
      .map((f) => ({ _id: f._id, condition: f.condition, revision: f.revision ?? 0 }));
  },
});

export const inboxIds = internalQuery({
  args: { accountId: v.id("accounts"), limit: v.number() },
  handler: async (ctx, { accountId, limit }) => {
    const rows = await ctx.db.query("threads").withIndex("by_account_last", q => q.eq("account_id", accountId)).order("desc").take(THREAD_WINDOW);
    return rows.filter(t => !t.deleted && t.label_ids.includes("INBOX") && !t.label_ids.some(l => l === "SPAM" || l === "TRASH")).slice(0, Math.max(1, Math.min(limit, THREAD_WINDOW))).map(t => t.gmail_id);
  },
});

export type JudgeRow = {
  gmail_id: string;
  from: string;
  to: string;
  subject: string;
  lane: string;
  body: string;
  has_attachments: boolean;
  inbound_at: number;
  message_count: number;
  last_at: number;
  /** The owner has written in this thread (its labels carry SENT). */
  i_wrote: boolean;
  /** Gmail's own importance guess. */
  gmail_important: boolean;
};

/** What the judge sees of a thread: its header line and the readable body of
 *  the newest inbound message (a condition can mention words only the body
 *  carries). `inboxOnly` with no ids feeds a dry run over the recent inbox. */
export const threadsForJudging = internalQuery({
  args: {
    accountId: v.id("accounts"),
    threadGmailIds: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { accountId, threadGmailIds, limit }) => {
    const account = await ctx.db.get(accountId);
    const threads: Doc<"threads">[] = [];
    if (threadGmailIds) {
      for (const id of threadGmailIds) {
        const t = await ctx.db
          .query("threads")
          .withIndex("by_account_gmail", (q) =>
            q.eq("account_id", accountId).eq("gmail_id", id),
          )
          .unique();
        if (t && !t.deleted) threads.push(t);
      }
    } else {
      let scanned = 0;
      for await (const t of ctx.db
        .query("threads")
        .withIndex("by_account_last", (q) => q.eq("account_id", accountId))
        .order("desc")) {
        if (++scanned > THREAD_WINDOW || threads.length >= (limit ?? 300)) break;
        if (t.deleted || !t.label_ids.includes(SYSTEM_LABEL_IDS.INBOX)) continue;
        if (t.label_ids.includes(SYSTEM_LABEL_IDS.TRASH) || t.label_ids.includes(SYSTEM_LABEL_IDS.SPAM)) continue;
        threads.push(t);
      }
    }
    const out: JudgeRow[] = [];
    for (const t of threads) {
      // Newest message from someone else, else the newest live one; read
      // one row at a time so a thread of heavy HTML costs one body, not six.
      let inbound: Doc<"messages"> | undefined;
      let fallback: Doc<"messages"> | undefined;
      let seen = 0;
      for await (const m of ctx.db
        .query("messages")
        .withIndex("by_account_thread", (q) =>
          q.eq("account_id", accountId).eq("thread_gmail_id", t.gmail_id),
        )
        .order("desc")) {
        if (++seen > 6) break;
        if (m.deleted) continue;
        fallback ??= m;
        if (!account || !isOwnAddress(account, m.from.email)) { inbound = m; break; }
      }
      inbound ??= fallback;
      const from = inbound?.from ?? t.participants[0];
      out.push({
        gmail_id: t.gmail_id,
        from: from ? (from.name ? `${from.name} <${from.email}>` : from.email) : "",
        to: (inbound?.to ?? []).map((a) => a.email).join(", ").slice(0, 120),
        subject: t.subject.slice(0, 140),
        lane: t.category ?? "primary",
        body: inbound ? readableBody(inbound, 1200) : t.snippet.slice(0, 200),
        has_attachments: t.has_attachments,
        inbound_at: inbound?.date ?? t.last_at,
        message_count: t.message_count,
        last_at: t.last_at,
        i_wrote: t.label_ids.includes(SYSTEM_LABEL_IDS.SENT),
        gmail_important: t.label_ids.includes(SYSTEM_LABEL_IDS.IMPORTANT),
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// What a hit does
// ---------------------------------------------------------------------------

type ActCtx = { db: MutationCtx["db"]; scheduler: MutationCtx["scheduler"] };

/** Which of the account's labels a name refers to (case-insensitive). */
export async function labelByName(
  ctx: ReadCtx,
  accountId: Id<"accounts">,
  name: string,
): Promise<Doc<"labels"> | null> {
  const wanted = name.trim().toLowerCase();
  const rows = await ctx.db
    .query("labels")
    .withIndex("by_account", (q) => q.eq("account_id", accountId))
    .collect();
  return rows.find((l) => !l.deleted && l.kind === "user" && l.name.toLowerCase() === wanted) ?? null;
}

/**
 * Check a parsed action list against the account: a label must exist, a
 * lane must be real. Returns the cleaned list or throws with the reason, so
 * a filter is never saved with an action that can do nothing.
 */
export async function validateActions(
  ctx: ReadCtx,
  accountId: Id<"accounts">,
  raw: unknown,
): Promise<FilterAction[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("A filter needs at least one action");
  }
  const out: FilterAction[] = [];
  if (raw.length > 8) throw new Error("Use at most eight actions");
  for (const entry of raw) {
    const kind = (entry as { kind?: unknown })?.kind;
    const arg = (entry as { arg?: unknown })?.arg;
    if (!FILTER_ACTION_KINDS.includes(kind as FilterActionKind)) {
      throw new Error(`Unknown action: ${String(kind)}`);
    }
    const k = kind as FilterActionKind;
    if (k === "label") {
      if (typeof arg !== "string" || !arg.trim()) throw new Error("A label action needs a label name");
      const label = await labelByName(ctx, accountId, arg);
      if (!label) throw new Error(`No Gmail label named "${arg}"`);
      out.push({ kind: k, arg: label.name });
    } else if (k === "lane") {
      const lane = typeof arg === "string" ? arg.trim().toLowerCase() : "";
      if (lane !== "primary" && !sanitizeCategory(lane)) throw new Error(`Unknown lane: ${String(arg)}`);
      out.push({ kind: k, arg: lane });
    } else if (k === "cluster") {
      if (typeof arg !== "string" || !arg.trim()) throw new Error("A cluster action needs a name");
      out.push({ kind: k, arg: arg.trim().slice(0, 48) });
    } else {
      out.push({ kind: k });
    }
  }
  return out;
}

/** One-line human reading of an action list, for the row and the CLI. */
export function describeActions(actions: FilterAction[]): string {
  return actions
    .map((a) => {
      switch (a.kind) {
        case "archive": return "archive";
        case "trash": return "trash";
        case "star": return "star";
        case "read": return "mark read";
        case "label": return `label “${a.arg}”`;
        case "lane": return `file under ${a.arg}`;
        case "cluster": return `topic “${a.arg}”`;
      }
    })
    .join(", ");
}

/** Run a filter's actions on one thread. Label changes ride the outbound
 *  queue exactly like a hand gesture; lanes and topics are local rows. */
export async function runActions(
  ctx: ActCtx,
  account: Doc<"accounts">,
  threadGmailId: string,
  actions: FilterAction[],
  now: number,
): Promise<void> {
  const add = new Set<string>();
  const remove = new Set<string>();
  for (const a of actions) {
    switch (a.kind) {
      case "archive":
        remove.add(SYSTEM_LABEL_IDS.INBOX);
        break;
      case "trash":
        add.add(SYSTEM_LABEL_IDS.TRASH);
        remove.add(SYSTEM_LABEL_IDS.INBOX);
        break;
      case "star":
        add.add(SYSTEM_LABEL_IDS.STARRED);
        break;
      case "read":
        remove.add(SYSTEM_LABEL_IDS.UNREAD);
        break;
      case "label": {
        const label = a.arg ? await labelByName(ctx, account._id, a.arg) : null;
        if (label) add.add(label.gmail_id);
        break;
      }
      case "lane": {
        const t = await threadByGmailId(ctx, account._id, threadGmailId);
        if (t && t.category_source !== "user") {
          await ctx.db.patch(t._id, {
            category: a.arg === "primary" ? undefined : a.arg,
            category_source: "rule",
            updated_at: now,
          });
        }
        break;
      }
      case "cluster": {
        const thread = await threadByGmailId(ctx, account._id, threadGmailId);
        if (thread?.cluster_source === "user") break;
        const cluster = await ensureCluster(
          ctx,
          account._id,
          { name: a.arg ?? "", source: "user" },
          now,
        );
        await placeThreads(ctx, account._id, [threadGmailId], cluster._id, "user", now);
        break;
      }
    }
  }
  if (add.size === 0 && remove.size === 0) return;
  await modifyThreadLabels(ctx, account, threadGmailId, [...add], [...remove]);
}

/** Land the judge's verdicts: every (filter, thread) hit runs the filter's
 *  actions and is remembered on the filter row. */
export const applyHits = internalMutation({
  args: {
    accountId: v.id("accounts"),
    includeOlder: v.optional(v.boolean()),
    hits: v.array(v.object({ filter_id: v.id("filters"), thread_gmail_id: v.string(), revision: v.number(), message_count: v.number(), last_at: v.number(), inbound_at: v.optional(v.number()) })),
  },
  handler: async (ctx, { accountId, hits, includeOlder }) => {
    const account = await ctx.db.get(accountId);
    if (!account) return { applied: 0 };
    const now = Date.now();
    let applied = 0;
    const touched = new Map<Id<"filters">, Doc<"filters">>();
    let rules: Awaited<ReturnType<typeof privacyRulesForUser>> | null = null;
    for (const hit of hits) {
      const filter = touched.get(hit.filter_id) ?? (await ctx.db.get(hit.filter_id));
      if (!filter || filter.account_id !== accountId || filter.deleted || !filter.enabled || (filter.revision ?? 0) !== hit.revision) continue;
      const thread = await threadByGmailId(ctx, accountId, hit.thread_gmail_id);
      if (!thread || thread.deleted || thread.message_count !== hit.message_count || thread.last_at !== hit.last_at || thread.label_ids.includes("TRASH") || thread.label_ids.includes("SPAM")) continue;
      if (!includeOlder && (hit.inbound_at ?? thread.last_at) < filter.created_at) continue;
      // An agent's filter acts only on mail its login could see.
      if (filter.hides_private) {
        rules ??= await privacyRulesForUser(ctx, account.user_id);
        if (threadPrivacy(thread, rules) !== "open") continue;
      }
      const previous = await ctx.db.query("filter_matches").withIndex("by_filter_thread", q => q.eq("filter_id", filter._id).eq("thread_gmail_id", thread.gmail_id)).unique();
      if (previous && previous.revision === hit.revision && previous.message_count === hit.message_count && previous.last_at === hit.last_at) continue;
      const mark = { account_id: accountId, filter_id: filter._id, thread_gmail_id: thread.gmail_id, revision: hit.revision, message_count: hit.message_count, last_at: hit.last_at, updated_at: now };
      if (previous) await ctx.db.patch(previous._id, mark);
      else await ctx.db.insert("filter_matches", mark);
      await runActions(ctx, account, hit.thread_gmail_id, filter.actions, now);
      const recent = [
        { thread_gmail_id: thread.gmail_id, subject: thread.subject.slice(0, 100), at: now },
        ...filter.recent.filter((r) => r.thread_gmail_id !== thread.gmail_id),
      ].slice(0, 5);
      const next = { ...filter, hits: filter.hits + 1, recent, updated_at: now };
      touched.set(filter._id, next);
      applied++;
    }
    for (const f of touched.values()) {
      await ctx.db.patch(f._id, { hits: f.hits, recent: f.recent, updated_at: f.updated_at });
    }
    if (applied > 0) await schedulePump(ctx, account);
    return { applied };
  },
});

export const recordCheck = internalMutation({
  args: { accountId: v.id("accounts"), filters: v.array(v.object({ id: v.id("filters"), revision: v.number() })), failed: v.boolean() },
  handler: async (ctx, { accountId, filters, failed }) => {
    for (const f of filters) {
      const row = await ctx.db.get(f.id);
      if (!row || row.deleted || row.account_id !== accountId || (row.revision ?? 0) !== f.revision) continue;
      await ctx.db.patch(row._id, { last_checked_at: Date.now(), last_error: failed ? "Could not check incoming mail. Review this filter or try running it again." : undefined, updated_at: Date.now() });
    }
  },
});
