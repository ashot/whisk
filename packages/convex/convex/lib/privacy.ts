import { Doc, Id } from "../_generated/dataModel";
import { resolveCaller, type ReadCtx } from "./auth";
import type { ScopeNeed } from "./apps";
import {
  privacyRulesFromPrefs,
  threadPrivacy,
  type PrivacyRule,
} from "@mail/shared/src/lib/privacy";

// The one gate between private mail and the logins kept from it (connected
// apps, terminal logins for agents). Every public function that returns or
// acts on mail resolves its caller through `mailReader` and asks `sees`
// before a thread, its messages, its drafts, its attachments, its summary or
// anything named after it leaves the server. A thread that is private, or
// not yet read against the person's rules, does not exist for such a caller:
// lists leave it out, lookups answer "not found", writes refuse it.
//
// The person's own sessions see everything, so for them `sees` is always
// true and this module costs one prefs read at most.

/** The person's privacy rules, from their prefs. */
export async function privacyRulesForUser(
  ctx: ReadCtx,
  userId: Id<"users"> | undefined,
): Promise<PrivacyRule[]> {
  if (!userId) return [];
  const state = await ctx.db
    .query("client_state")
    .withIndex("by_user", (q) => q.eq("user_id", userId))
    .unique();
  return privacyRulesFromPrefs(state?.prefs as { privacy_rules?: unknown } | undefined);
}

export type MailReader = {
  /** The accounts in reach: all the caller's, or the one asked for. */
  accounts: Doc<"accounts">[];
  /** Kept from private mail: a connected app or an agent terminal. */
  hidesPrivate: boolean;
  rules: PrivacyRule[];
  /** Whether this caller may see the thread. */
  sees(thread: Doc<"threads">): boolean;
};

/**
 * The caller as a reader of mail. With `accountId`, only that account (it
 * must be the caller's), as requireAccount resolves it.
 */
export async function mailReader(
  ctx: ReadCtx,
  token: string | undefined,
  scope: ScopeNeed = "mail.read",
  accountId?: Id<"accounts">,
): Promise<MailReader> {
  const { accounts, hidesPrivate } = await resolveCaller(ctx, token, scope);
  let reach = accounts;
  if (accountId !== undefined) {
    if (accounts.length === 0) throw new Error("Unauthorized: no connected accounts");
    const match = accounts.find((a) => a._id === accountId);
    if (!match) throw new Error("Unauthorized: account not in this session");
    reach = [match];
  }
  return readerFor(ctx, reach, hidesPrivate);
}

/** A reader over accounts already resolved (dispatch, a context query). */
export async function readerFor(
  ctx: ReadCtx,
  accounts: Doc<"accounts">[],
  hidesPrivate: boolean,
): Promise<MailReader> {
  const rules = hidesPrivate ? await privacyRulesForUser(ctx, accounts[0]?.user_id) : [];
  return {
    accounts,
    hidesPrivate,
    rules,
    sees: (thread) => !hidesPrivate || threadPrivacy(thread, rules) === "open",
  };
}

/** A thread by its Gmail id, or by the Gmail id of a message in it. */
export async function threadForId(
  ctx: ReadCtx,
  accountId: Id<"accounts">,
  gmailId: string,
): Promise<Doc<"threads"> | null> {
  const thread = await ctx.db
    .query("threads")
    .withIndex("by_account_gmail", (q) => q.eq("account_id", accountId).eq("gmail_id", gmailId))
    .unique();
  if (thread) return thread;
  const message = await ctx.db
    .query("messages")
    .withIndex("by_account_gmail", (q) => q.eq("account_id", accountId).eq("gmail_id", gmailId))
    .unique();
  if (!message || message.deleted) return null;
  return await ctx.db
    .query("threads")
    .withIndex("by_account_gmail", (q) =>
      q.eq("account_id", accountId).eq("gmail_id", message.thread_gmail_id),
    )
    .unique();
}

/** Whether the reader may see the thread a Gmail id (thread or message)
 *  names in an account. An id that names nothing is the caller's own
 *  business (not found downstream), so it passes. */
export async function seesId(
  ctx: ReadCtx,
  reader: MailReader,
  accountId: Id<"accounts">,
  gmailId: string,
): Promise<boolean> {
  if (!reader.hidesPrivate) return true;
  const thread = await threadForId(ctx, accountId, gmailId);
  return !thread || reader.sees(thread);
}

/**
 * What a reader kept from a thread receives in its place on a delta stream:
 * a tombstone with the ids and the watermark, and nothing the thread says.
 * A client that held the row while it was open drops it.
 */
export function hiddenThreadRow(row: Doc<"threads">): Doc<"threads"> {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    account_id: row.account_id,
    gmail_id: row.gmail_id,
    subject: "",
    snippet: "",
    participants: [],
    message_count: 0,
    last_at: 0,
    label_ids: [],
    is_unread: false,
    is_starred: false,
    has_attachments: false,
    updated_at: row.updated_at,
    deleted: true,
  };
}

/**
 * Every thread or message id a dispatch payload names, with the account it
 * names it in. Side effects name mail through these fields and no others
 * (thread ops, reminders, lanes, topics, lens marks, replies, forwarded
 * files); a new side effect that names mail must use them too, or teach
 * this function its field.
 */
export function payloadMailRefs(payload: any): Array<{ account_id?: string; id: string }> {
  const out: Array<{ account_id?: string; id: string }> = [];
  const account = typeof payload?.account_id === "string" ? payload.account_id : undefined;
  const add = (id: unknown, accountId = account) => {
    if (typeof id === "string" && id) out.push({ account_id: accountId, id });
  };
  const addAll = (ids: unknown, accountId = account) => {
    if (Array.isArray(ids)) for (const id of ids) add(id, accountId);
  };
  add(payload?.thread_gmail_id);
  addAll(payload?.thread_gmail_ids);
  add(payload?.reply_to_gmail_id);
  if (Array.isArray(payload?.attachments)) {
    for (const file of payload.attachments) add(file?.message_gmail_id);
  }
  if (Array.isArray(payload?.ops)) {
    for (const op of payload.ops) {
      addAll(op?.thread_gmail_ids, typeof op?.account_id === "string" ? op.account_id : account);
    }
  }
  return out;
}

/** Refuse a write that names mail the reader cannot see, with the same
 *  words as a thread that does not exist. */
export async function assertPayloadVisible(
  ctx: ReadCtx,
  reader: MailReader,
  payload: unknown,
): Promise<void> {
  if (!reader.hidesPrivate) return;
  for (const ref of payloadMailRefs(payload)) {
    const account = ref.account_id
      ? reader.accounts.find((a) => a._id === ref.account_id)
      : reader.accounts[0];
    if (!account) continue; // accountForPayload refuses it downstream
    if (!(await seesId(ctx, reader, account._id, ref.id))) throw new Error("Thread not found");
  }
}
