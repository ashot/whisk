import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { fromAddress } from "@mail/shared/src/lib/sendAs";
import {
  backoffMs,
  batchDelete,
  batchModify,
  deleteDraftByMessage,
  fetchAttachmentBytes,
  getAccessToken,
  sendMessage as gmailSend,
  type MimeAttachment,
} from "./api";
import type { OutgoingAttachment } from "@mail/shared/src/store/types";
import { normalizeLabels, recomputeThread, threadByGmailId } from "../lib/threads";
import { runCalendarOutbound } from "../calendar/outbound";
import { isLocalId } from "../lib/outbound";

// The outbound queue drains here, one row at a time in creation order. Order
// matters: an archive queued before a send must not overtake it, or Gmail sees
// a different mailbox than the user does.

const MAX_ATTEMPTS = 5;
// Rows per invocation, so a long queue can't outlive one action's budget.
const BATCH = 25;
// An inflight row older than this lost its pump (action timeout, deploy mid-run,
// isolate crash). Requeue it so the send/modify actually happens.
const INFLIGHT_STALE_MS = 11 * 60 * 1000;

export { isLocalId };

export const pump = internalAction({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    let processed = 0;

    // Recover rows a previous pump left inflight when it died. Without this a
    // crashed send is lost forever — claimNext only sees "queued".
    await ctx.runMutation(internal.gmail.pump.reapStaleInflight, { accountId });

    for (let i = 0; i < BATCH; i++) {
      const row = await ctx.runMutation(internal.gmail.pump.claimNext, {
        accountId,
      });
      if (!row) break;

      try {
        const accessToken = await getAccessToken(ctx, accountId);
        await runOutbound(ctx, accountId, accessToken, row);
        await ctx.runMutation(internal.gmail.pump.finish, {
          outboundId: row._id,
          status: "done",
          attempt: row.attempts,
        });
        processed++;
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : String(caught);
        const exhausted = row.attempts >= MAX_ATTEMPTS;
        await ctx.runMutation(internal.gmail.pump.finish, {
          outboundId: row._id,
          status: exhausted ? "error" : "queued",
          attempt: row.attempts,
          retry_at: exhausted ? undefined : Date.now() + backoffMs(row.attempts),
          error: message,
          surface_on_account: exhausted,
        });
        if (exhausted) {
          // The send will never happen; its uploads have no reader left.
          if (row.kind === "send") await freeSendUploads(ctx, row.payload?.attachments);
          continue;
        }
        // Back off and let a later pump pick the row up, rather than spinning
        // the rest of the queue behind a failing row.
        await ctx.scheduler.runAfter(
          backoffMs(row.attempts),
          internal.gmail.pump.pump,
          { accountId },
        );
        if (row.kind === "calendar") continue;
        return { processed, retried: true };
      }
    }

    if (processed === BATCH) await ctx.scheduler.runAfter(0, internal.gmail.pump.pump, { accountId });
    return { processed, retried: false };
  },
});

async function runOutbound(
  ctx: any,
  accountId: Id<"accounts">,
  accessToken: string,
  row: { _id: Id<"outbound">; kind: string; payload: any },
) {
  const payload = row.payload ?? {};

  if (row.kind === "modify" && payload.op === "delete") {
    const ids = (payload.message_gmail_ids ?? []).filter(
      (id: string) => !isLocalId(id),
    );
    await batchDelete(accessToken, ids);
    return;
  }

  if (row.kind === "modify" && payload.op === "deleteDraft") {
    await deleteDraftByMessage(accessToken, payload.message_gmail_id);
    return;
  }

  if (row.kind === "modify") {
    const ids = (payload.message_gmail_ids ?? []).filter(
      (id: string) => !isLocalId(id),
    );
    await batchModify(accessToken, {
      ids,
      addLabelIds: payload.add_label_ids ?? [],
      removeLabelIds: payload.remove_label_ids ?? [],
    });
    return;
  }

  if (row.kind === "send") {
    const account = await ctx.runQuery(internal.gmail.sync.accountFor, {
      accountId,
    });
    if (!account) throw new Error("Account disappeared mid-send");
    const threadId: string | undefined =
      payload.is_reply && !isLocalId(payload.thread_gmail_id ?? "")
        ? payload.thread_gmail_id
        : undefined;

    const files: OutgoingAttachment[] = payload.attachments ?? [];
    const sent = await gmailSend(accessToken, {
      // Resolved when the send was queued; a row queued before that sends
      // as the account's default.
      from: payload.from ?? fromAddress(account),
      to: payload.to ?? [],
      cc: payload.cc ?? [],
      bcc: payload.bcc ?? [],
      subject: payload.subject ?? "",
      bodyText: payload.body_text ?? "",
      inReplyTo: payload.in_reply_to,
      references: payload.references,
      messageId: `<${payload.client_id}@mail.local>`,
      threadId,
      attachments: await loadAttachments(ctx, accessToken, files),
    });

    await ctx.runMutation(internal.gmail.pump.applySendResult, {
      accountId,
      client_id: payload.client_id,
      gmail_id: sent.id,
      thread_gmail_id: sent.threadId,
      label_ids: sent.labelIds ?? ["SENT"],
    });
    // Gmail holds the bytes now; the uploads have served their purpose.
    await freeSendUploads(ctx, files);
    return;
  }

  if (row.kind === "calendar") {
    await runCalendarOutbound(ctx, accountId, accessToken, payload);
    return;
  }

  throw new Error(`Unknown outbound kind: ${row.kind}`);
}

/** The bytes of every file on a send: uploads from storage, forwarded files
 *  from the message they came with. A missing one fails the send (so it can
 *  retry) rather than quietly leaving without the file. */
async function loadAttachments(
  ctx: any,
  accessToken: string,
  files: readonly OutgoingAttachment[],
): Promise<MimeAttachment[]> {
  const out: MimeAttachment[] = [];
  for (const f of files) {
    if (f.storage_id) {
      const blob = await ctx.storage.get(f.storage_id as Id<"_storage">);
      if (!blob) throw new Error(`Upload for "${f.filename}" is gone`);
      out.push({ filename: f.filename, mimeType: f.mime_type, bytes: new Uint8Array(await blob.arrayBuffer()) });
    } else if (f.message_gmail_id) {
      const found = await fetchAttachmentBytes(accessToken, f.message_gmail_id, {
        attachmentId: f.gmail_attachment_id,
        filename: f.filename,
      });
      if (!found) throw new Error(`"${f.filename}" is no longer on message ${f.message_gmail_id}`);
      out.push({ filename: f.filename, mimeType: f.mime_type, bytes: found.bytes });
    }
  }
  return out;
}

async function freeSendUploads(ctx: any, files: readonly OutgoingAttachment[] | undefined): Promise<void> {
  for (const f of files ?? []) {
    if (f.storage_id) await ctx.storage.delete(f.storage_id as Id<"_storage">).catch(() => {});
  }
}

// Requeue inflight rows a dead pump abandoned. Kept as its own mutation so the
// pump reaps at start and a cron can drive it even when no new op arrives.
export const reapStaleInflight = internalMutation({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const cutoff = Date.now() - INFLIGHT_STALE_MS;
    const inflight = await ctx.db
      .query("outbound")
      .withIndex("by_account_status", (q) =>
        q.eq("account_id", accountId).eq("status", "inflight"),
      )
      .collect();
    let requeued = 0;
    for (const row of inflight) {
      if (row.updated_at > cutoff) continue;
      // Exhausted rows go to error, not into an endless requeue loop.
      const status = row.attempts >= MAX_ATTEMPTS ? "error" : "queued";
      await ctx.db.patch(row._id, {
        status,
        error: status === "error" ? "Abandoned inflight (pump crash); gave up" : row.error,
        updated_at: Date.now(),
      });
      if (status === "error" && row.kind === "calendar") {
        const account = await ctx.db.get(accountId);
        if (account) await ctx.db.patch(accountId, { calendar_write_error: "Calendar write abandoned after repeated pump crashes", updated_at: Date.now() });
        const event = row.payload.event_id ? await ctx.db.get(row.payload.event_id as Id<"events">) : null;
        if (event?.account_id === accountId) await ctx.db.patch(event._id, { write_error: "Calendar write abandoned after repeated pump crashes", pending_outbound: event.pending_outbound === row._id ? undefined : event.pending_outbound, updated_at: Date.now() });
      }
      if (status === "queued") requeued++;
    }
    return { requeued };
  },
});

// Cron entry: pump every gmail account. Each pump run reaps its own stale
// inflight rows first, so this doubles as the recovery driver.
export const pumpAllAccounts = internalAction({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const accountIds: Array<Id<"accounts">> = await ctx.runQuery(
      internal.gmail.pump.accountsWithOutbound,
      {},
    );
    for (const accountId of accountIds) {
      await ctx.scheduler.runAfter(0, internal.gmail.pump.pump, { accountId });
    }
    return { scheduled: accountIds.length };
  },
});

// Accounts holding any unfinished outbound row (queued or inflight).
export const accountsWithOutbound = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<Id<"accounts">>> => {
    const accounts = await ctx.db.query("accounts").collect();
    const out: Array<Id<"accounts">> = [];
    for (const a of accounts) {
      if (a.provider !== "gmail") continue;
      const queued = await ctx.db
        .query("outbound")
        .withIndex("by_account_status", (q) =>
          q.eq("account_id", a._id).eq("status", "queued"),
        )
        .first();
      const inflight = queued
        ? null
        : await ctx.db
            .query("outbound")
            .withIndex("by_account_status", (q) =>
              q.eq("account_id", a._id).eq("status", "inflight"),
            )
            .first();
      if (queued || inflight) out.push(a._id);
    }
    return out;
  },
});

export const claimNext = internalMutation({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    if (!await ctx.db.get(accountId)) return null;
    const inflight = await ctx.db.query("outbound").withIndex("by_account_status", q =>
      q.eq("account_id", accountId).eq("status", "inflight")).first();
    if (inflight) return null;
    const queued = await ctx.db.query("outbound").withIndex("by_account_kind_status", q =>
      q.eq("account_id", accountId).eq("kind", "calendar").eq("status", "queued")).order("asc").take(500);
    const blocked = new Set<string>();
    let row = null;
    for (const candidate of queued) {
      const key = candidate.payload.event_id ?? `${candidate.payload.calendar_google_id}:${candidate.payload.google_id ?? candidate.payload.client_id}`;
      const event = candidate.payload.event_id ? await ctx.db.get(candidate.payload.event_id as Id<"events">) : null;
      if (event?.write_error || blocked.has(key) || (candidate.retry_at ?? 0) > Date.now()) {
        blocked.add(key);
        continue;
      }
      row = candidate;
      break;
    }
    const mail = [];
    for (const kind of ["modify", "send"] as const) {
      const candidate = await ctx.db.query("outbound").withIndex("by_account_kind_status", q =>
        q.eq("account_id", accountId).eq("kind", kind).eq("status", "queued")).first();
      if (candidate) mail.push(candidate);
    }
    mail.sort((a, b) => a.created_at - b.created_at || a._creationTime - b._creationTime);
    const nextMail = mail[0];
    if (nextMail && (nextMail.retry_at ?? 0) <= Date.now() &&
        (!row || nextMail.created_at < row.created_at || (nextMail.created_at === row.created_at && nextMail._creationTime < row._creationTime))) row = nextMail;
    if (!row) return null;
    await ctx.db.patch(row._id, {
      status: "inflight",
      attempts: row.attempts + 1,
      updated_at: Date.now(),
    });
    return { ...row, status: "inflight" as const, attempts: row.attempts + 1 };
  },
});

export const finish = internalMutation({
  args: {
    outboundId: v.id("outbound"),
    status: v.union(
      v.literal("done"),
      v.literal("queued"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
    surface_on_account: v.optional(v.boolean()),
    attempt: v.optional(v.number()),
    retry_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.outboundId);
    if (!row || (args.attempt !== undefined && (row.attempts !== args.attempt || row.status !== "inflight"))) return;
    await ctx.db.patch(args.outboundId, {
      status: args.status,
      error: args.error,
      retry_at: args.retry_at,
      updated_at: Date.now(),
    });
    const account = await ctx.db.get(row.account_id);
    if (!account) return;
    if (row.kind === "calendar") {
      const event = row.payload.event_id ? await ctx.db.get(row.payload.event_id as Id<"events">) : null;
      if (event?.account_id === row.account_id) {
        await ctx.db.patch(event._id, {
          pending_outbound: (args.status === "done" || args.status === "error") && event.pending_outbound === row._id ? undefined : event.pending_outbound,
          write_error: args.status === "error" ? args.error : event.write_error,
          local_written_at: Math.max(Date.now(), (event.local_written_at ?? 0) + 1), updated_at: Date.now(),
        });
      }
      if (args.status === "error") await ctx.db.patch(row.account_id, { calendar_write_error: args.error, updated_at: Date.now() });
    } else if (args.surface_on_account && args.error) {
      await ctx.db.patch(row.account_id, { sync_status: "error", sync_error: args.error, updated_at: Date.now() });
    }
  },
});

/**
 * Replace the local ids on a sent message (and its thread, when the send
 * created one) with the ids Gmail assigned. `client_id` survives the rewrite so
 * the client's optimistic stub rekeys instead of doubling.
 */
export const applySendResult = internalMutation({
  args: {
    accountId: v.id("accounts"),
    client_id: v.string(),
    gmail_id: v.string(),
    thread_gmail_id: v.string(),
    label_ids: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const message = await ctx.db
      .query("messages")
      .withIndex("by_account_client", (q) =>
        q.eq("account_id", args.accountId).eq("client_id", args.client_id),
      )
      .unique();
    if (!message) return { rekeyed: false };

    const oldThreadId = message.thread_gmail_id;
    await ctx.db.patch(message._id, {
      gmail_id: args.gmail_id,
      thread_gmail_id: args.thread_gmail_id,
      label_ids: normalizeLabels(args.label_ids),
      updated_at: now,
    });

    if (oldThreadId !== args.thread_gmail_id) {
      // Everything that pointed at the local thread follows it over.
      const siblings = await ctx.db
        .query("messages")
        .withIndex("by_account_thread", (q) =>
          q
            .eq("account_id", args.accountId)
            .eq("thread_gmail_id", oldThreadId),
        )
        .collect();
      for (const sibling of siblings) {
        await ctx.db.patch(sibling._id, {
          thread_gmail_id: args.thread_gmail_id,
          updated_at: now,
        });
      }

      const localThread = await threadByGmailId(
        ctx,
        args.accountId,
        oldThreadId,
      );
      const realThread = await threadByGmailId(
        ctx,
        args.accountId,
        args.thread_gmail_id,
      );
      if (localThread && realThread) {
        // Gmail threaded the send onto a conversation we already hold: retire
        // the local stub rather than leaving two rows for one thread.
        await ctx.db.patch(localThread._id, { deleted: true, updated_at: now });
      } else if (localThread) {
        await ctx.db.patch(localThread._id, {
          gmail_id: args.thread_gmail_id,
          updated_at: now,
        });
      }
    }

    await recomputeThread(ctx, args.accountId, args.thread_gmail_id);
    return { rekeyed: true };
  },
});
