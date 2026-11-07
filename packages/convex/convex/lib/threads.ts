import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";

// One place owns "what a thread row says about its messages". Thread ops, the
// send path and the Gmail sync all funnel through `recomputeThread`, so a
// thread's unread dot can never disagree with the messages under it.

export const SYSTEM_LABEL_IDS = {
  INBOX: "INBOX",
  STARRED: "STARRED",
  SENT: "SENT",
  DRAFT: "DRAFT",
  TRASH: "TRASH",
  SPAM: "SPAM",
  UNREAD: "UNREAD",
  IMPORTANT: "IMPORTANT",
} as const;

export type Address = { name?: string; email: string };

export type ThreadCtx = { db: MutationCtx["db"] };

/**
 * The canonical form of a label set: deduplicated and sorted.
 *
 * Sorting is a contract with the client, not a tidiness preference. The client
 * protects an optimistic field write until the server echo matches it by
 * value, and it sorts what it writes — so a server row carrying the same
 * labels in a different order would never compare equal and the pending lock
 * would never be released. Every write of `label_ids` goes through here.
 */
export function normalizeLabels(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** Add and remove label ids in one pass, returning the canonical form. */
export function applyLabelDelta(
  current: readonly string[],
  add: readonly string[] = [],
  remove: readonly string[] = [],
): string[] {
  const removeSet = new Set(remove);
  const next = current.filter((id) => !removeSet.has(id));
  for (const id of add) {
    if (!removeSet.has(id)) next.push(id);
  }
  return normalizeLabels(next);
}

export async function threadByGmailId(
  ctx: ThreadCtx,
  accountId: Id<"accounts">,
  threadGmailId: string,
): Promise<Doc<"threads"> | null> {
  return await ctx.db
    .query("threads")
    .withIndex("by_account_gmail", (q) =>
      q.eq("account_id", accountId).eq("gmail_id", threadGmailId),
    )
    .unique();
}

export async function messageByGmailId(
  ctx: ThreadCtx,
  accountId: Id<"accounts">,
  gmailId: string,
): Promise<Doc<"messages"> | null> {
  return await ctx.db
    .query("messages")
    .withIndex("by_account_gmail", (q) =>
      q.eq("account_id", accountId).eq("gmail_id", gmailId),
    )
    .unique();
}

export async function threadMessageRows(
  ctx: ThreadCtx,
  accountId: Id<"accounts">,
  threadGmailId: string,
): Promise<Doc<"messages">[]> {
  const rows: Doc<"messages">[] = await ctx.db
    .query("messages")
    .withIndex("by_account_thread", (q) =>
      q.eq("account_id", accountId).eq("thread_gmail_id", threadGmailId),
    )
    .collect();
  return rows.filter((m) => !m.deleted);
}

/** Distinct senders in first-seen order — what a list row shows as "from". */
export function participantsOf(messages: readonly Doc<"messages">[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const message of messages) {
    const key = message.from.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      message.from.name
        ? { name: message.from.name, email: message.from.email }
        : { email: message.from.email },
    );
  }
  return out;
}

/** The derived half of a thread row, computed from its messages. */
export function deriveThreadFields(messages: readonly Doc<"messages">[]) {
  const ordered = [...messages].sort((a, b) => a.date - b.date);
  const labelIds = normalizeLabels(ordered.flatMap((m) => m.label_ids));
  const last = ordered[ordered.length - 1];
  return {
    message_count: ordered.length,
    last_at: last ? last.date : 0,
    snippet: last ? last.snippet : "",
    participants: participantsOf(ordered),
    label_ids: labelIds,
    is_unread: ordered.some((m) => m.is_unread),
    is_starred: labelIds.includes(SYSTEM_LABEL_IDS.STARRED),
    has_attachments: ordered.some((m) => m.attachments.length > 0),
  };
}

/**
 * Rewrite a thread row from its live messages. Returns the patched thread, or
 * null when the thread has no rows left (every message deleted) — the caller
 * decides whether that means tombstoning the thread.
 */
export async function recomputeThread(
  ctx: ThreadCtx,
  accountId: Id<"accounts">,
  threadGmailId: string,
  extra: Record<string, unknown> = {},
): Promise<Doc<"threads"> | null> {
  const thread = await threadByGmailId(ctx, accountId, threadGmailId);
  if (!thread) return null;
  const messages = await threadMessageRows(ctx, accountId, threadGmailId);
  const patch = {
    ...deriveThreadFields(messages),
    ...extra,
    updated_at: Date.now(),
  };
  // An empty thread keeps its last known summary rather than collapsing to a
  // blank row; only `deleted` (passed in `extra`) retires it.
  if (messages.length === 0) {
    delete (patch as any).message_count;
    delete (patch as any).last_at;
    delete (patch as any).snippet;
    delete (patch as any).participants;
  }
  await ctx.db.patch(thread._id, patch);
  return { ...thread, ...patch } as Doc<"threads">;
}

/** After messages leave a thread: a thread whose last message is gone is
 *  gone, any other is rewritten from what remains. */
export async function settleThread(
  ctx: ThreadCtx,
  accountId: Id<"accounts">,
  threadGmailId: string,
): Promise<void> {
  const thread = await threadByGmailId(ctx, accountId, threadGmailId);
  if (!thread) return;
  if ((await threadMessageRows(ctx, accountId, threadGmailId)).length === 0) {
    await ctx.db.patch(thread._id, { deleted: true, updated_at: Date.now() });
    return;
  }
  await recomputeThread(ctx, accountId, threadGmailId);
}

/**
 * Apply a label delta to every message in a thread, then rewrite the thread
 * row. This is the single primitive behind archive, trash, read, unread, star
 * and user-label changes.
 */
export async function applyLabelsToThread(
  ctx: ThreadCtx,
  accountId: Id<"accounts">,
  threadGmailId: string,
  add: readonly string[],
  remove: readonly string[],
): Promise<{ thread: Doc<"threads"> | null; messageGmailIds: string[] }> {
  const messages = await threadMessageRows(ctx, accountId, threadGmailId);
  const now = Date.now();
  for (const message of messages) {
    const labelIds = applyLabelDelta(message.label_ids, add, remove);
    if (sameLabels(labelIds, message.label_ids)) continue;
    await ctx.db.patch(message._id, {
      label_ids: labelIds,
      is_unread: labelIds.includes(SYSTEM_LABEL_IDS.UNREAD),
      updated_at: now,
    });
  }
  const refreshed = await threadMessageRows(ctx, accountId, threadGmailId);
  const thread = await recomputeThread(ctx, accountId, threadGmailId);
  return {
    thread,
    messageGmailIds: refreshed.map((m) => m.gmail_id),
  };
}

export function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
