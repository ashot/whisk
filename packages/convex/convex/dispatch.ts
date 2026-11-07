import { createEvent, updateEvent, deleteEvent, rsvpEvent, retryCalendarWrites } from "./calendar/write";
import { v, type Infer } from "convex/values";
import {
  applyPatches,
  sideEffectPayload,
  singleton,
} from "@platform/engine-convex";
import { mutation, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  requireAccounts,
  requireUserId,
  sessionsForToken,
  touchSession,
} from "./lib/auth";
import {
  SYSTEM_LABEL_IDS,
  applyLabelsToThread,
  messageByGmailId,
  normalizeLabels,
  recomputeThread,
  threadByGmailId,
  threadMessageRows,
} from "./lib/threads";
import { deleteAccountAndMaybeUser } from "./lib/accounts";
import type { AppScope } from "./lib/apps";
import { enqueueOutbound, schedulePump } from "./lib/outbound";
import { freeUploads, retireGmailDraft } from "./lib/drafts";
import { sanitizeCategory } from "./lib/categorize";
import { fromAddress, isOwnAddress } from "@mail/shared/src/lib/sendAs";
import {
  clusterNamed,
  dissolveClusterRows,
  ensureCluster,
  normalizeClusterName,
  placeThreads,
  scheduleClustering,
  clusteringSettings,
  streamsInTheme,
  threadsInCluster,
} from "./clusters";
import { describeActions, liveFilters, validateActions } from "./filters";
import { spendModelBudget } from "./ai/filterSupport";
import { markImportance, scheduleInboxPass } from "./importance";
import { IMPORTANCE_BATCH, IMPORTANCE_INBOX_PASS } from "./ai/importance";
import { checkOutgoingSize, outgoingAsAttachments } from "@mail/shared/src/lib/attachments";
import { outgoingAttachmentValidator } from "./schema";

type OutgoingAttachment = Infer<typeof outgoingAttachmentValidator>;

// The one write rail. A client action produces (a) generic field patches for
// tables the client is allowed to own, and (b) a named side effect for
// everything that needs server logic. Both arrive in a single mutation so an
// optimistic UI write and its server consequence can never half-apply.

type Address = { name?: string; email: string };

// The client-writable allowlist. `singleton` builds the shape the engine
// expects; `prefs` is the open bag, so a new client preference never needs a
// schema change and never fails validation.
const TABLE_CONFIG = {
  client_state: singleton(
    [
      "theme",
      "rail_collapsed",
      "density",
      "image_allowed_senders",
      "signature",
      "onboarding_dismissed",
      "notifications",
      "calendar",
      "last_view",
      "prefs",
    ],
    {
      // Owned by the user, not the account. `account_id` is immutable so a
      // client can never plant the owner these rows used to carry.
      ownerField: "user_id",
      lookupIndex: "by_user",
      overflowField: "prefs",
      extraImmutable: ["account_id"],
    },
  ),
};

type Ctx = { db: MutationCtx["db"]; scheduler: MutationCtx["scheduler"]; storage: MutationCtx["storage"] };

export const dispatch = mutation({
  args: {
    // Optional during the Convex Auth migration: a signed-in caller is
    // resolved from ctx.auth and needs no token.
    token: v.optional(v.string()),
    action: v.string(),
    args: v.any(),
    patches: v.optional(v.any()),
    result: v.optional(v.any()),
  },
  handler: async (ctx, { token, action, args: actionArgs, patches, result }) => {
    // A connected app reaches only the side effects its scopes cover (an
    // unknown action needs no scope, and does nothing). Prefs patches below
    // resolve with no scope, so an app can never write them.
    const accounts = await requireAccounts(
      ctx,
      token,
      Object.prototype.hasOwnProperty.call(SIDE_EFFECTS, action)
        ? (DISPATCH_SCOPES[action as SideEffectName] ?? undefined)
        : undefined,
    );
    await touchSession(ctx, token);

    // Prefs belong to the USER, so theme/density follow the person across
    // devices. Resolving the user here also upgrades legacy sessions in
    // place on their first write.
    if (patches && typeof patches === "object") {
      const userId = await requireUserId(ctx, token);
      await applyPatches(ctx, TABLE_CONFIG, userId, patches);
    }

    const sideEffect = Object.prototype.hasOwnProperty.call(SIDE_EFFECTS, action)
      ? SIDE_EFFECTS[action as SideEffectName]
      : undefined;
    if (sideEffect) {
      const payload = sideEffectPayload(actionArgs);
      // The payload names which of the session's accounts it acts on; absent
      // means the primary. An account outside the session fails closed.
      const account = accountForPayload(accounts, payload);
      return await sideEffect(ctx, { account, accounts, token }, payload, result);
    }
    return null;
  },
});

/** Resolve a payload's account_id against the session, defaulting to primary. */
export function accountForPayload(
  accounts: Doc<"accounts">[],
  payload: { account_id?: string } | undefined,
): Doc<"accounts"> {
  if (accounts.length === 0) {
    // A signed-in Convex Auth caller with nothing connected yet.
    throw new Error("Unauthorized: no connected accounts");
  }
  const wanted = payload?.account_id;
  if (!wanted) return accounts[0];
  const match = accounts.find((a) => a._id === wanted);
  if (!match) throw new Error("Unauthorized: account not in this session");
  return match;
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

type Session = {
  account: Doc<"accounts">;
  accounts: Doc<"accounts">[];
  token: string | undefined;
};

type SideEffect = (
  ctx: Ctx,
  session: Session,
  args: any,
  result?: any,
) => Promise<any>;

export type ThreadOp = {
  thread_gmail_ids: string[];
  add_label_ids?: string[];
  remove_label_ids?: string[];
  // Which of the session's accounts the threads live in. Absent = the
  // payload's account (single-account clients never set it).
  account_id?: string;
};

/**
 * The one primitive under archive, trash, read/unread, star and user labels.
 * Each op is a batch: rows apply immediately, and the whole batch becomes a
 * single outbound modify row so Gmail sees one round trip per gesture. A
 * gesture in the unified view spans accounts — each op names its own.
 */
async function applyThreadOps(
  ctx: Ctx,
  session: Session,
  args: { ops?: ThreadOp[] },
) {
  const ops = Array.isArray(args?.ops) ? args.ops : [];
  const applied: Array<{ thread_gmail_id: string; label_ids: string[] }> = [];
  const pumpAccounts = new Map<string, Doc<"accounts">>();

  for (const op of ops) {
    const account = accountForPayload(session.accounts, {
      account_id: op?.account_id ?? (session.account._id as string),
    });
    const threadIds = Array.isArray(op?.thread_gmail_ids)
      ? op.thread_gmail_ids
      : [];
    const add = op?.add_label_ids ?? [];
    const remove = op?.remove_label_ids ?? [];
    if (threadIds.length === 0 || (add.length === 0 && remove.length === 0)) {
      continue;
    }

    const messageGmailIds: string[] = [];
    const touched: string[] = [];
    for (const threadGmailId of threadIds) {
      const { thread, messageGmailIds: ids } = await applyLabelsToThread(
        ctx,
        account._id,
        threadGmailId,
        add,
        remove,
      );
      if (!thread) continue;
      touched.push(threadGmailId);
      messageGmailIds.push(...ids);
      applied.push({
        thread_gmail_id: threadGmailId,
        label_ids: thread.label_ids,
      });
    }

    if (touched.length === 0) continue;
    await enqueueOutbound(ctx, account, "modify", {
      op: "modify",
      thread_gmail_ids: touched,
      message_gmail_ids: messageGmailIds,
      add_label_ids: add,
      remove_label_ids: remove,
    });
    pumpAccounts.set(account._id, account);
  }

  for (const account of pumpAccounts.values()) {
    await schedulePump(ctx, account);
  }
  return { applied };
}

/** Gmail moves a thread to spam by label, and out of the inbox at the same time. */
const markSpam: SideEffect = async (ctx, session, args) =>
  applyThreadOps(ctx, session, {
    ops: [
      {
        thread_gmail_ids: args?.thread_gmail_ids ?? [],
        add_label_ids: [SYSTEM_LABEL_IDS.SPAM],
        remove_label_ids: [SYSTEM_LABEL_IDS.INBOX],
        account_id: args?.account_id,
      },
    ],
  });

/**
 * Permanent delete has no label form: rows tombstone locally and the pump
 * calls Gmail's delete rather than modify.
 */
const deleteForever: SideEffect = async (ctx, { account }, args) => {
  const threadIds: string[] = args?.thread_gmail_ids ?? [];
  const now = Date.now();
  const deleted: string[] = [];
  const messageGmailIds: string[] = [];

  for (const threadGmailId of threadIds) {
    const thread = await threadByGmailId(ctx, account._id, threadGmailId);
    if (!thread) continue;
    const messages = await threadMessageRows(ctx, account._id, threadGmailId);
    for (const message of messages) {
      messageGmailIds.push(message.gmail_id);
      await ctx.db.patch(message._id, { deleted: true, updated_at: now });
    }
    await ctx.db.patch(thread._id, { deleted: true, updated_at: now });
    deleted.push(threadGmailId);
  }

  if (deleted.length > 0) {
    await enqueueOutbound(ctx, account, "modify", {
      op: "delete",
      thread_gmail_ids: deleted,
      message_gmail_ids: messageGmailIds,
    });
    await schedulePump(ctx, account);
  }
  return { deleted };
};

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function snippetOf(text: string, max = 200): string {
  const flat = collapse(text);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function asAddresses(input: unknown): Address[] {
  if (!Array.isArray(input)) return [];
  const out: Address[] = [];
  for (const entry of input) {
    if (typeof entry === "string") {
      const email = entry.trim();
      if (email) out.push({ email });
    } else if (entry && typeof entry === "object" && (entry as any).email) {
      const address = entry as Address;
      out.push(
        address.name
          ? { name: address.name, email: address.email }
          : { email: address.email },
      );
    }
  }
  return out;
}

/**
 * The files a send or draft names, checked: an upload must exist in storage
 * (its size and type come from there, not from the client); a forwarded
 * file must name a message of this account. Anything else is dropped.
 */
async function asOutgoingAttachments(
  ctx: Ctx,
  accountId: Id<"accounts">,
  raw: unknown,
): Promise<OutgoingAttachment[]> {
  if (!Array.isArray(raw)) return [];
  const out: OutgoingAttachment[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object" || typeof f.filename !== "string") continue;
    const filename: string = f.filename;
    if (typeof f.storage_id === "string") {
      const storageId = f.storage_id as Id<"_storage">;
      const stored = await ctx.db.system.get(storageId);
      if (!stored) throw new Error(`Uploaded file "${filename}" was not found`);
      out.push({
        filename,
        mime_type: stored.contentType || f.mime_type || "application/octet-stream",
        size: stored.size,
        storage_id: storageId,
      });
    } else if (typeof f.message_gmail_id === "string" && typeof f.gmail_attachment_id === "string") {
      const source = await messageByGmailId(ctx, accountId, f.message_gmail_id);
      const part = source?.attachments.find((a) => a.gmail_attachment_id === f.gmail_attachment_id);
      if (!part) throw new Error(`No file "${filename}" on message ${f.message_gmail_id}`);
      out.push({ ...part, message_gmail_id: f.message_gmail_id });
    }
  }
  checkOutgoingSize(out);
  return out;
}

/**
 * Append a sent message. Deduped on `client_id`, so a retried dispatch — a
 * reload mid-send, an outbox redrive — never sends twice.
 */
const sendMessage: SideEffect = async (ctx, { account }, args) => {
  const clientId: string = args?.client_id;
  if (!clientId) throw new Error("sendMessage requires client_id");

  const existing = await ctx.db
    .query("messages")
    .withIndex("by_account_client", (q) =>
      q.eq("account_id", account._id).eq("client_id", clientId),
    )
    .unique();
  if (existing) {
    return {
      deduped: true,
      message_gmail_id: existing.gmail_id,
      thread_gmail_id: existing.thread_gmail_id,
    };
  }

  const now = Date.now();
  const to = asAddresses(args?.to);
  const cc = asAddresses(args?.cc);
  const bcc = asAddresses(args?.bcc);
  const bodyText: string = args?.body_text ?? "";
  const attachments = await asOutgoingAttachments(ctx, account._id, args?.attachments);

  // Reply headers come off the message being answered, so the pump never has
  // to re-fetch it to build a correct In-Reply-To/References chain.
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let threadGmailId: string | undefined = args?.thread_gmail_id ?? undefined;
  const replyToGmailId: string | undefined = args?.reply_to_gmail_id ?? undefined;

  if (replyToGmailId) {
    const parent = await messageByGmailId(ctx, account._id, replyToGmailId);
    if (parent) {
      inReplyTo = parent.header_message_id;
      references = [parent.references, parent.header_message_id]
        .filter(Boolean)
        .join(" ") || undefined;
      threadGmailId ??= parent.thread_gmail_id;
    }
  }

  const isReply = !!threadGmailId;
  threadGmailId ??= `local-thread-${clientId}`;
  const messageGmailId = `local-msg-${clientId}`;
  const subject: string = args?.subject ?? "";
  // Only an address the mailbox may send as; anything else sends as the default.
  const from = fromAddress(account, typeof args?.from === "string" ? args.from : undefined);

  await ctx.db.insert("messages", {
    account_id: account._id,
    thread_gmail_id: threadGmailId,
    gmail_id: messageGmailId,
    from,
    to,
    cc,
    bcc,
    date: now,
    snippet: snippetOf(bodyText),
    body_text: bodyText,
    label_ids: normalizeLabels([SYSTEM_LABEL_IDS.SENT]),
    is_unread: false,
    attachments: outgoingAsAttachments(attachments),
    header_message_id: `<${clientId}@mail.local>`,
    in_reply_to: inReplyTo,
    references,
    client_id: clientId,
    updated_at: now,
  });

  const thread = await threadByGmailId(ctx, account._id, threadGmailId);
  if (!thread) {
    await ctx.db.insert("threads", {
      account_id: account._id,
      gmail_id: threadGmailId,
      subject,
      snippet: snippetOf(bodyText),
      participants: [],
      message_count: 0,
      last_at: now,
      label_ids: [],
      is_unread: false,
      is_starred: false,
      has_attachments: false,
      client_id: clientId,
      updated_at: now,
    });
  }
  // Derivation is never duplicated: the thread row is rewritten from its
  // messages exactly like a label op or a Gmail sync would do it.
  await recomputeThread(ctx, account._id, threadGmailId, isReply ? {} : { subject });

  // Sending a compose retires its draft; the client reuses one client_id for
  // both, so the tombstone reaches it through the same delta channel. The
  // draft's uploads now belong to the send: only the ones it dropped are freed.
  const draft = await ctx.db
    .query("drafts")
    .withIndex("by_account_client", (q) =>
      q.eq("account_id", account._id).eq("client_id", clientId),
    )
    .unique();
  if (draft && !draft.deleted) {
    await ctx.db.patch(draft._id, { deleted: true, updated_at: now });
    await freeUploads(ctx, draft.attachments, attachments);
    await retireGmailDraft(ctx, account, draft);
  }

  await enqueueOutbound(ctx, account, "send", {
    op: "send",
    client_id: clientId,
    message_gmail_id: messageGmailId,
    thread_gmail_id: threadGmailId,
    is_reply: isReply,
    from,
    to,
    cc,
    bcc,
    subject,
    body_text: bodyText,
    in_reply_to: inReplyTo,
    references,
    attachments,
  });
  await schedulePump(ctx, account);

  return {
    deduped: false,
    message_gmail_id: messageGmailId,
    thread_gmail_id: threadGmailId,
  };
};

const saveDraft: SideEffect = async (ctx, { account }, args) => {
  const clientId: string = args?.client_id;
  if (!clientId) throw new Error("saveDraft requires client_id");
  const now = Date.now();

  const fields = {
    thread_gmail_id: args?.thread_gmail_id ?? undefined,
    from: typeof args?.from === "string" ? args.from : undefined,
    to: asAddresses(args?.to),
    cc: asAddresses(args?.cc),
    bcc: asAddresses(args?.bcc),
    subject: args?.subject ?? "",
    body_text: args?.body_text ?? "",
    reply_to_gmail_id: args?.reply_to_gmail_id ?? undefined,
    mode: args?.mode ?? "new",
    attachments: await asOutgoingAttachments(ctx, account._id, args?.attachments),
    updated_at: now,
  };

  const existing = await ctx.db
    .query("drafts")
    .withIndex("by_account_client", (q) =>
      q.eq("account_id", account._id).eq("client_id", clientId),
    )
    .unique();

  if (existing) {
    // A resurrected draft clears its tombstone.
    await ctx.db.patch(existing._id, { ...fields, deleted: undefined });
    await freeUploads(ctx, existing.attachments, fields.attachments);
    return { client_id: clientId, created: false };
  }
  await ctx.db.insert("drafts", {
    account_id: account._id,
    client_id: clientId,
    ...fields,
  });
  return { client_id: clientId, created: true };
};

const deleteDraft: SideEffect = async (ctx, { account }, args) => {
  const clientId: string = args?.client_id;
  if (!clientId) throw new Error("deleteDraft requires client_id");
  const existing = await ctx.db
    .query("drafts")
    .withIndex("by_account_client", (q) =>
      q.eq("account_id", account._id).eq("client_id", clientId),
    )
    .unique();
  // A tombstone, not a row delete: the client learns about it through the same
  // `updated_at` delta channel as every other change. Its uploads go for good.
  if (existing) {
    await ctx.db.patch(existing._id, { deleted: true, updated_at: Date.now() });
    await freeUploads(ctx, existing.attachments);
    await retireGmailDraft(ctx, account, existing);
  }
  return { client_id: clientId, deleted: !!existing };
};

/**
 * Disconnect one of the session's accounts: revoke the Google grant, delete
 * the access-bearing rows now, and scrub the mirrored mailbox in background
 * batches. Returns how many accounts remain so the client knows whether the
 * session itself just ended.
 */
const disconnectAccount: SideEffect = async (ctx, { account, accounts }) => {
  if (account.provider === "gmail") {
    const credentials = await ctx.db
      .query("credentials")
      .withIndex("by_account", (q) => q.eq("account_id", account._id))
      .unique();
    if (credentials) {
      // Revoking the refresh token kills the whole grant at Google. The job
      // carries the token still sealed (scheduled arguments are stored) and
      // opens it itself; the key, not the deleted row, is all it needs.
      await ctx.scheduler.runAfter(0, internal.gmail.oauth.revokeToken, {
        accountId: account._id,
        sealed: credentials.refresh_token,
      });
      await ctx.db.delete(credentials._id);
    }
  }
  const { userDeleted } = await deleteAccountAndMaybeUser(ctx, account);
  await ctx.scheduler.runAfter(0, internal.accounts.wipeRows, {
    accountId: account._id,
  });
  return {
    disconnected: true,
    remaining: userDeleted ? 0 : accounts.length - 1,
  };
};

/** End this device's legacy login. The account and its data stay for other
 *  devices. A Convex Auth session ends through api.auth.signOut instead; a
 *  caller with no token has nothing to delete here. */
const signOut: SideEffect = async (ctx, { token }) => {
  if (!token) return { signedOut: true };
  for (const session of await sessionsForToken(ctx, token)) {
    await ctx.db.delete(session._id);
  }
  return { signedOut: true };
};

// ---------------------------------------------------------------------------
// Filing: categories, corrections, and the sender rules they teach
// ---------------------------------------------------------------------------

/** How many recent threads a new sender rule re-files in one pass. */
const RULE_SWEEP_CAP = 500;

/**
 * Upsert the sender→lane rule a correction teaches, then re-file every recent
 * thread from that sender. This is the "correct it once" contract: one gesture
 * moves the whole history, not just the row under the cursor.
 */
async function applySenderRule(
  ctx: Ctx,
  account: Doc<"accounts">,
  senderEmail: string,
  category: string | null,
  now: number,
): Promise<number> {
  const categoryName = category
    ? category[0].toUpperCase() + category.slice(1)
    : "Primary";
  const rules = await ctx.db
    .query("memories")
    .withIndex("by_account_contact", (q) =>
      q.eq("account_id", account._id).eq("contact_email", senderEmail),
    )
    .collect();
  const rule = rules.find((m) => m.kind === "rule");
  const text = `Mail from ${senderEmail} files under ${categoryName}`;
  if (rule) {
    await ctx.db.patch(rule._id, {
      text,
      category: category ?? undefined,
      deleted: undefined,
      updated_at: now,
    });
  } else {
    await ctx.db.insert("memories", {
      account_id: account._id,
      kind: "rule",
      text,
      contact_email: senderEmail,
      category: category ?? undefined,
      source: "correction",
      created_at: now,
      updated_at: now,
    });
  }

  // Sweep: the rule applies to what is already here, not just future mail.
  // Only threads the sender STARTED move — a rule about a newsletter must
  // never drag in a real conversation the same person merely replied to.
  let refiled = 0;
  let scanned = 0;
  for await (const thread of ctx.db
    .query("threads")
    .withIndex("by_account_last", (q) => q.eq("account_id", account._id))
    .order("desc")) {
    if (++scanned > RULE_SWEEP_CAP) break;
    if (thread.deleted || thread.category_source === "user") continue;
    if (thread.participants[0]?.email.toLowerCase() !== senderEmail) continue;
    if (thread.category === (category ?? undefined)) continue;
    await ctx.db.patch(thread._id, {
      category: category ?? undefined,
      category_source: "rule",
      updated_at: now,
    });
    refiled++;
  }
  return refiled;
}

/**
 * A correction: file threads under a lane (null = back to primary). The named
 * threads become "user"-sourced (final); with `remember` (the default) each
 * distinct sender also gets a rule, which re-files their other mail.
 */
const setCategory: SideEffect = async (ctx, session, args) => {
  const account = accountForPayload(session.accounts, args);
  const category = args?.category == null ? null : sanitizeCategory(args.category);
  if (args?.category != null && !category) {
    throw new Error(`Unknown category: ${args.category}`);
  }
  const threadIds: string[] = args?.thread_gmail_ids ?? [];
  const remember = args?.remember !== false;
  const now = Date.now();
  const senders = new Set<string>();

  for (const threadGmailId of threadIds) {
    const thread = await threadByGmailId(ctx, account._id, threadGmailId);
    if (!thread || thread.deleted) continue;
    await ctx.db.patch(thread._id, {
      category: category ?? undefined,
      category_source: "user",
      updated_at: now,
    });
    const sender = thread.participants.find((p) => !isOwnAddress(account, p.email));
    if (sender) senders.add(sender.email.toLowerCase());
  }

  let refiled = 0;
  if (remember) {
    for (const sender of senders) {
      refiled += await applySenderRule(ctx, account, sender, category, now);
    }
  }
  return { refiled, senders: [...senders] };
};

// ---------------------------------------------------------------------------
// Importance
// ---------------------------------------------------------------------------

/** A hand mark: threads the person says are (or are not) important. Null
 *  hands them back to the model. */
const setImportance: SideEffect = async (ctx, session, args) => {
  const account = accountForPayload(session.accounts, args);
  const important = args?.important;
  if (important !== null && typeof important !== "boolean") throw new Error("setImportance needs important: true, false or null");
  return await markImportance(ctx, account, args?.thread_gmail_ids ?? [], important);
};

/** The policy itself rides the prefs patch in this same dispatch; this
 *  judges every mailbox's recent inbox again under it. */
const setImportancePolicy: SideEffect = async (ctx, session) => {
  for (const account of session.accounts) await spendModelBudget(ctx, account, Math.ceil(IMPORTANCE_INBOX_PASS / IMPORTANCE_BATCH));
  await scheduleInboxPass(ctx, session.accounts.map((a) => a._id));
  return { scheduled: session.accounts.length };
};

// ---------------------------------------------------------------------------
// Reminders: snooze and follow-up watches
// ---------------------------------------------------------------------------

const setReminder: SideEffect = async (ctx, session, args) => {
  const account = accountForPayload(session.accounts, args);
  const threadGmailId: string = args?.thread_gmail_id;
  const kind: string = args?.kind;
  const remindAt: number = args?.remind_at;
  if (!threadGmailId || (kind !== "snooze" && kind !== "followup")) {
    throw new Error("setReminder requires thread_gmail_id and a valid kind");
  }
  if (typeof remindAt !== "number" || remindAt <= Date.now() - 60_000) {
    throw new Error("setReminder requires a future remind_at");
  }
  const thread = await threadByGmailId(ctx, account._id, threadGmailId);
  if (!thread || thread.deleted) throw new Error("Thread not found");

  const now = Date.now();
  // One armed reminder per thread — arming again replaces.
  const existing = await ctx.db
    .query("reminders")
    .withIndex("by_account_thread", (q) =>
      q.eq("account_id", account._id).eq("thread_gmail_id", threadGmailId),
    )
    .collect();
  for (const reminder of existing) {
    if (reminder.status === "armed") {
      await ctx.db.patch(reminder._id, { status: "canceled", updated_at: now });
    }
  }
  await ctx.db.insert("reminders", {
    account_id: account._id,
    thread_gmail_id: threadGmailId,
    kind,
    remind_at: remindAt,
    baseline_last_at: thread.last_at,
    status: "armed",
    created_at: now,
    updated_at: now,
  });

  // A snooze leaves the inbox now; Gmail mirrors the archive.
  if (kind === "snooze") {
    const { messageGmailIds } = await applyLabelsToThread(
      ctx,
      account._id,
      threadGmailId,
      [],
      [SYSTEM_LABEL_IDS.INBOX],
    );
    await enqueueOutbound(ctx, account, "modify", {
      op: "modify",
      thread_gmail_ids: [threadGmailId],
      message_gmail_ids: messageGmailIds,
      add_label_ids: [],
      remove_label_ids: [SYSTEM_LABEL_IDS.INBOX],
    });
    await schedulePump(ctx, account);
  }
  return { armed: true };
};

/** Unsnooze / stop watching / dismiss a fired watch — one verb for the client. */
const cancelReminder: SideEffect = async (ctx, session, args) => {
  const account = accountForPayload(session.accounts, args);
  const threadGmailId: string = args?.thread_gmail_id;
  if (!threadGmailId) throw new Error("cancelReminder requires thread_gmail_id");
  const now = Date.now();
  const rows = await ctx.db
    .query("reminders")
    .withIndex("by_account_thread", (q) =>
      q.eq("account_id", account._id).eq("thread_gmail_id", threadGmailId),
    )
    .collect();
  let restoreInbox = false;
  for (const reminder of rows) {
    if (reminder.status === "armed") {
      await ctx.db.patch(reminder._id, { status: "canceled", updated_at: now });
      if (reminder.kind === "snooze") restoreInbox = true;
    } else if (reminder.status === "fired") {
      await ctx.db.patch(reminder._id, { status: "resolved", updated_at: now });
    }
  }
  if (restoreInbox) {
    const { messageGmailIds } = await applyLabelsToThread(
      ctx,
      account._id,
      threadGmailId,
      [SYSTEM_LABEL_IDS.INBOX],
      [],
    );
    await enqueueOutbound(ctx, account, "modify", {
      op: "modify",
      thread_gmail_ids: [threadGmailId],
      message_gmail_ids: messageGmailIds,
      add_label_ids: [SYSTEM_LABEL_IDS.INBOX],
      remove_label_ids: [],
    });
    await schedulePump(ctx, account);
  }
  return { canceled: true };
};

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

const addMemory: SideEffect = async (ctx, session, args) => {
  const account = accountForPayload(session.accounts, args);
  const text: string = (args?.text ?? "").trim();
  if (!text) throw new Error("addMemory requires text");
  const contactEmail: string | undefined = args?.contact_email || undefined;
  const now = Date.now();
  const id = await ctx.db.insert("memories", {
    account_id: account._id,
    kind: contactEmail ? "contact" : "preference",
    text,
    contact_email: contactEmail?.toLowerCase(),
    source: "manual",
    created_at: now,
    updated_at: now,
  });
  return { memory_id: id };
};

const deleteMemory: SideEffect = async (ctx, session, args) => {
  const memoryId: string = args?.memory_id;
  if (!memoryId) throw new Error("deleteMemory requires memory_id");
  const memory = await ctx.db.get(memoryId as Id<"memories">);
  if (!memory) return { deleted: false };
  if (!session.accounts.some((a) => a._id === memory.account_id)) {
    throw new Error("Unauthorized: memory not in this session");
  }
  await ctx.db.patch(memory._id, { deleted: true, updated_at: Date.now() });
  return { deleted: true };
};

// ---------------------------------------------------------------------------
// Topics: the controls over what the model clustered
// ---------------------------------------------------------------------------

async function clusterOrThrow(ctx: Ctx, account: Doc<"accounts">, id: unknown) {
  const key = typeof id === "string" ? ctx.db.normalizeId("clusters", id) : null;
  const cluster = key ? await ctx.db.get(key) : null;
  if (!cluster || cluster.deleted || cluster.account_id !== account._id) {
    throw new Error("No such topic");
  }
  return cluster;
}

/** Make a topic by hand, optionally seeded with threads. A hand-made topic
 *  is the person's: a regroup never touches it. */
const createCluster: SideEffect = async (ctx, session, args) => {
  const account = accountForPayload(session.accounts, args);
  const now = Date.now();
  const cluster = await ensureCluster(
    ctx,
    account._id,
    { name: args?.name ?? "", description: args?.description, source: "user" },
    now,
  );
  if (cluster.source !== "user") await ctx.db.patch(cluster._id, { source: "user", updated_at: now });
  const ids: string[] = Array.isArray(args?.thread_gmail_ids) ? args.thread_gmail_ids : [];
  const placed = await placeThreads(ctx, account._id, ids, cluster._id, "user", now);
  return { cluster_id: cluster._id, placed };
};

/** Rename or describe a topic, or file a stream under a theme (`parent_id`,
 *  null to take it out). The name and description are what the model reads
 *  to place future mail, so this is also how a person teaches it what the
 *  topic means; where they file a stream is their word too. */
const renameCluster: SideEffect = async (ctx, session, args) => {
  const account = accountForPayload(session.accounts, args);
  const cluster = await clusterOrThrow(ctx, account, args?.cluster_id);
  const now = Date.now();
  const patch: Partial<Doc<"clusters">> = { source: "user", updated_at: now };
  if (typeof args?.name === "string") {
    const name = normalizeClusterName(args.name);
    if (!name) throw new Error("A topic needs a name");
    const clash = await clusterNamed(ctx, account._id, name, cluster.kind, cluster._id);
    if (clash) throw new Error(`There is already a topic named "${clash.name}"`);
    patch.name = name;
  }
  if (typeof args?.description === "string") {
    patch.description = args.description.trim().slice(0, 240);
  }
  if (args?.parent_id === null) {
    patch.parent_id = undefined;
  } else if (typeof args?.parent_id === "string") {
    const parent = await clusterOrThrow(ctx, account, args.parent_id);
    if (parent.kind !== "theme" || cluster.kind === "theme") throw new Error("Only a stream can sit in a theme");
    patch.parent_id = parent._id;
  }
  await ctx.db.patch(cluster._id, patch);
  return { renamed: true };
};

/** Fold topics into one: every thread moves, a theme's streams move with
 *  it, the sources vanish. */
const mergeClusters: SideEffect = async (ctx, session, args) => {
  const account = accountForPayload(session.accounts, args);
  const into = await clusterOrThrow(ctx, account, args?.into_id);
  const from: unknown[] = Array.isArray(args?.from_ids) ? args.from_ids : [];
  const now = Date.now();
  let moved = 0;
  for (const id of from) {
    if (id === into._id) continue;
    const source = await clusterOrThrow(ctx, account, id);
    if ((source.kind === "theme") !== (into.kind === "theme")) throw new Error("A theme merges into a theme, a topic into a topic");
    const rows = await threadsInCluster(ctx, account._id, source._id);
    for (const t of rows) {
      await ctx.db.patch(t._id, { cluster_id: into._id, cluster_source: "user", updated_at: now });
      moved++;
    }
    for (const s of await streamsInTheme(ctx, account._id, source._id)) {
      await ctx.db.patch(s._id, { parent_id: into.kind === "theme" ? into._id : undefined, updated_at: now });
    }
    await ctx.db.patch(source._id, { deleted: true, updated_at: now });
  }
  // A merge is a judgement about what belongs together: keep the result.
  await ctx.db.patch(into._id, { source: "user", updated_at: now });
  return { moved };
};

/** Take a topic apart. Its threads are marked judged so an incremental
 *  pass does not quietly rebuild what the person just undid; a theme's
 *  streams stand on their own again. */
const dissolveCluster: SideEffect = async (ctx, session, args) => {
  const account = accountForPayload(session.accounts, args);
  const cluster = await clusterOrThrow(ctx, account, args?.cluster_id);
  const freed = await dissolveClusterRows(ctx, cluster, Date.now(), { judged: true });
  return { freed };
};

/** How a topic sits in the inbox: hidden from the list, and whether mail
 *  that joins it from now on is archived as it arrives. Both at once is a
 *  muted topic. Either switch is the person's word, so the topic becomes
 *  theirs and survives regroups. */
const setClusterTreatment: SideEffect = async (ctx, session, args) => {
  const account = accountForPayload(session.accounts, args);
  const cluster = await clusterOrThrow(ctx, account, args?.cluster_id);
  const now = Date.now();
  const hidden = typeof args?.hidden === "boolean" ? args.hidden : !!cluster.hidden;
  const archiveSince = typeof args?.archive_new === "boolean" ? (args.archive_new ? (cluster.archive_new_since ?? now) : undefined) : cluster.archive_new_since;
  await ctx.db.patch(cluster._id, { source: "user", hidden, archive_new_since: archiveSince, updated_at: now });
  return { hidden, archive_new: archiveSince !== undefined };
};

/** Move threads into a topic (or out of every topic with null). A hand
 *  placement is final for the model. */
const setThreadCluster: SideEffect = async (ctx, session, args) => {
  const account = accountForPayload(session.accounts, args);
  const ids: string[] = Array.isArray(args?.thread_gmail_ids) ? args.thread_gmail_ids : [];
  const cluster =
    args?.cluster_id == null ? null : await clusterOrThrow(ctx, account, args.cluster_id);
  const moved = await placeThreads(
    ctx,
    account._id,
    ids,
    cluster ? cluster._id : null,
    "user",
    Date.now(),
  );
  return { moved };
};

const regroupClusters: SideEffect = async (ctx, session, args) => {
  const account = accountForPayload(session.accounts, args);
  if (!(await clusteringSettings(ctx, account)).enabled) throw new Error("Auto-group is off for this mailbox. Turn it on in Settings, or run: whisk topic settings --auto on");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("AI is not configured on this deployment");
  // A fresh regroup of a big inbox is a dozen model calls; it draws on the
  // same hourly budget as the other on-demand AI.
  await spendModelBudget(ctx, account, args?.fresh === true ? 15 : 3);
  await scheduleClustering(ctx, account, { delayMs: 0, fresh: args?.fresh === true });
  return { scheduled: true };
};

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** The filter row an id names, if it is a filter id at all; the caller
 *  still checks the account. */
async function ownedFilter(ctx: Ctx, id: unknown): Promise<Doc<"filters"> | null> {
  const key = typeof id === "string" ? ctx.db.normalizeId("filters", id) : null;
  return key ? await ctx.db.get(key) : null;
}

async function filterOrThrow(ctx: Ctx, account: Doc<"accounts">, id: unknown) {
  const filter = await ownedFilter(ctx, id);
  if (!filter || filter.deleted || filter.account_id !== account._id) {
    throw new Error("No such filter");
  }
  return filter;
}

/**
 * Save a filter the client already had parsed (parseFilter) and previewed.
 * With `apply_now` the recent inbox is judged against it right away;
 * otherwise it only meets mail from here on.
 */
const saveFilter: SideEffect = async (ctx, session, args) => {
  const account = accountForPayload(session.accounts, args);
  const text = typeof args?.text === "string" ? args.text.trim() : "";
  const condition = typeof args?.condition === "string" ? args.condition.trim() : "";
  if (!text || !condition || text.length > 2000 || condition.length > 2000) throw new Error("A filter needs a sentence and condition of at most 2,000 characters");
  const actions = await validateActions(ctx, account._id, args?.actions);
  const filters = await liveFilters(ctx, account._id);
  const existing = args?.filter_id
    ? await filterOrThrow(ctx, account, args.filter_id)
    : filters.find(f => f.text.toLowerCase() === text.toLowerCase());
  if (!existing && filters.length >= 20) throw new Error("Use up to 20 filters per mailbox");
  const now = Date.now();
  const fields = { text, condition, actions, updated_at: now };
  let id: Id<"filters">;
  if (existing) {
    const changed = existing.text !== text || existing.condition !== condition || JSON.stringify(existing.actions) !== JSON.stringify(actions);
    if (changed) await ctx.db.patch(existing._id, { ...fields, revision: (existing.revision ?? 0) + 1, last_error: undefined });
    id = existing._id;
  } else {
    id = await ctx.db.insert("filters", { account_id: account._id, ...fields, enabled: true, hits: 0, recent: [], created_at: now });
  }
  // Apply now acts only on the conversations the person was shown in the
  // preview (their gmail ids ride along); without them, nothing old is
  // touched — "run on inbox" is the deliberate wider gesture.
  const previewed = Array.isArray(args?.thread_gmail_ids) ? (args.thread_gmail_ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 400) : [];
  if (args?.apply_now === true && previewed.length > 0 && process.env.ANTHROPIC_API_KEY) {
    await ctx.scheduler.runAfter(0, internal.ai.actions.judgeFilters, {
      accountId: account._id,
      filterIds: [id],
      threadGmailIds: previewed,
      includeOlder: true,
    });
  }
  return { filter_id: id, summary: describeActions(actions) };
};

const setFilterEnabled: SideEffect = async (ctx, session, args) => {
  const owned = await ownedFilter(ctx, args?.filter_id);
  const account = accountForPayload(session.accounts, { account_id: owned?.account_id ?? args?.account_id });
  const filter = await filterOrThrow(ctx, account, args?.filter_id);
  const enabled = args?.enabled !== false;
  if (filter.enabled !== enabled) await ctx.db.patch(filter._id, { enabled, revision: (filter.revision ?? 0) + 1, updated_at: Date.now() });
  return { enabled };
};

const deleteFilter: SideEffect = async (ctx, session, args) => {
  const owned = await ownedFilter(ctx, args?.filter_id);
  const account = accountForPayload(session.accounts, { account_id: owned?.account_id ?? args?.account_id });
  const filter = await filterOrThrow(ctx, account, args?.filter_id);
  await ctx.db.patch(filter._id, { deleted: true, updated_at: Date.now() });
  return { deleted: true };
};

/** Judge the recent inbox against one filter (or all of them) now. */
const runFilters: SideEffect = async (ctx, session, args) => {
  const account = accountForPayload(session.accounts, args);
  await spendModelBudget(ctx, account, 15);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("AI is not configured on this deployment");
  const selected = args?.filter_id ? await filterOrThrow(ctx, account, args.filter_id) : undefined;
  if (selected && !selected.enabled) throw new Error("Enable this filter before running it");
  const filterIds = selected ? [selected._id] : undefined;
  await ctx.scheduler.runAfter(0, internal.ai.actions.judgeFilters, {
    accountId: account._id,
    filterIds,
    includeOlder: true,
  });
  return { scheduled: true };
};

const SIDE_EFFECTS = {
  createEvent,
  updateEvent,
  deleteEvent,
  rsvpEvent,
  retryCalendarWrites,
  setCategory,
  setImportance,
  setImportancePolicy,
  setReminder,
  cancelReminder,
  addMemory,
  deleteMemory,
  applyThreadOps: (ctx, session, args) => applyThreadOps(ctx, session, args),
  markSpam,
  deleteForever,
  sendMessage,
  saveDraft,
  deleteDraft,
  disconnectAccount,
  signOut,
  createCluster,
  renameCluster,
  mergeClusters,
  dissolveCluster,
  setClusterTreatment,
  setThreadCluster,
  regroupClusters,
  saveFilter,
  setFilterEnabled,
  deleteFilter,
  runFilters,
} satisfies Record<string, SideEffect>;

type SideEffectName = keyof typeof SIDE_EFFECTS;

/**
 * What a connected app needs to run each side effect (lib/apps). Null means
 * no app may: only the person's own sessions (browser, terminal) can. Typed
 * over every side effect, so a new one cannot ship without a decision here.
 * The consent screen promises read, draft, send and organize mail, and read,
 * add and change calendar events; nothing outside that is reachable.
 * Deleting an event and answering an invitation stay the person's own.
 */
export const DISPATCH_SCOPES: Record<SideEffectName, AppScope | null> = {
  createEvent: "calendar.write",
  retryCalendarWrites: "calendar.write",
  updateEvent: "calendar.write",
  deleteEvent: null,
  rsvpEvent: null,
  setCategory: "mail.organize",
  setImportance: "mail.organize",
  setImportancePolicy: null,
  setReminder: "mail.organize",
  cancelReminder: "mail.organize",
  addMemory: null,
  deleteMemory: null,
  applyThreadOps: "mail.organize",
  markSpam: "mail.organize",
  deleteForever: null,
  sendMessage: "mail.send",
  saveDraft: "mail.draft",
  deleteDraft: "mail.draft",
  disconnectAccount: null,
  signOut: null,
  createCluster: "mail.organize",
  renameCluster: "mail.organize",
  mergeClusters: "mail.organize",
  dissolveCluster: "mail.organize",
  setClusterTreatment: "mail.organize",
  setThreadCluster: "mail.organize",
  regroupClusters: "mail.organize",
  saveFilter: "mail.organize",
  setFilterEnabled: "mail.organize",
  deleteFilter: "mail.organize",
  runFilters: "mail.organize",
};
