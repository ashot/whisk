import { opensForward, writtenPart } from "@mail/shared/src/lib/quotes";
import type { Infer } from "convex/values";
import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { enqueueOutbound, schedulePump } from "./outbound";
import { SYSTEM_LABEL_IDS, threadMessageRows, type Address } from "./threads";
import { outgoingAttachmentValidator } from "../schema";

type OutgoingAttachment = Infer<typeof outgoingAttachmentValidator>;

// Drafts saved to Gmail (in Gmail itself, or any client that writes there)
// sync in as messages labeled DRAFT. Whisk keeps them as drafts: the same rows
// its own composer writes, so they open in the composer instead of reading as
// mail. Gmail rewrites a draft as a new message on every save, so a row is
// keyed by the message it came from, and retires when Gmail drops it.

type Ctx = { db: MutationCtx["db"]; scheduler: MutationCtx["scheduler"]; storage: MutationCtx["storage"] };

export function isGmailDraft(m: { label_ids: readonly string[] }): boolean {
  return m.label_ids.includes(SYSTEM_LABEL_IDS.DRAFT);
}

export function gmailDraftClientId(messageGmailId: string): string {
  return `gmail-draft-${messageGmailId}`;
}

async function draftByClientId(ctx: { db: MutationCtx["db"] }, accountId: Id<"accounts">, clientId: string) {
  return await ctx.db
    .query("drafts")
    .withIndex("by_account_client", (q) => q.eq("account_id", accountId).eq("client_id", clientId))
    .unique();
}

/** A Gmail draft becomes a Whisk draft. A row already there is left alone:
 *  it may carry edits, or a discard, made in Whisk since. `rewrite` rewrites
 *  a live one from its message instead (a one-off repair, never sync);
 *  `create: false` only ever touches a row that exists. */
export async function adoptGmailDraft(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  m: {
    gmail_id: string;
    thread_gmail_id: string;
    from: Address;
    to: Address[];
    cc?: Address[];
    bcc?: Address[];
    subject: string;
    snippet: string;
    body_text?: string;
    in_reply_to?: string;
  },
  opts: { rewrite?: boolean; create?: boolean } = {},
): Promise<void> {
  const clientId = gmailDraftClientId(m.gmail_id);
  const existing = await draftByClientId(ctx, accountId, clientId);
  if (existing ? !opts.rewrite || existing.deleted : opts.create === false) return;
  const text = m.body_text ?? m.snippet;
  const cc = m.cc ?? [];
  // A forward carries what it forwards and leaves its conversation, as
  // Whisk's own forwards do.
  const forward = opensForward(text);
  // A reply answers its newest message, unless its headers name another; a
  // draft with no conversation is fresh mail.
  const thread = forward
    ? []
    : (await threadMessageRows(ctx, accountId, m.thread_gmail_id)).filter((row) => !isGmailDraft(row));
  const parent =
    thread.find((row) => !!m.in_reply_to && row.header_message_id === m.in_reply_to) ?? thread[thread.length - 1];
  const mode: Doc<"drafts">["mode"] = forward
    ? "forward"
    : parent
      ? m.to.length + cc.length > 1
        ? "replyAll"
        : "reply"
      : "new";
  const fields = {
    thread_gmail_id: parent ? m.thread_gmail_id : undefined,
    reply_to_gmail_id: parent?.gmail_id,
    mode,
    from: m.from.email,
    to: m.to,
    cc,
    bcc: m.bcc ?? [],
    subject: m.subject,
    // Whisk sends replies without the quoted trail, so a reply holds only
    // what was written; a forward keeps what it forwards.
    body_text: writtenPart(text),
    updated_at: Date.now(),
  };
  if (existing) await ctx.db.patch(existing._id, fields);
  else await ctx.db.insert("drafts", { account_id: accountId, client_id: clientId, gmail_message_id: m.gmail_id, ...fields });
}

/** Gmail dropped the draft (sent, discarded or rewritten there): so does Whisk. */
export async function dropGmailDraft(ctx: Ctx, accountId: Id<"accounts">, messageGmailId: string): Promise<void> {
  const row = await draftByClientId(ctx, accountId, gmailDraftClientId(messageGmailId));
  if (!row || row.deleted) return;
  await ctx.db.patch(row._id, { deleted: true, updated_at: Date.now() });
  await freeUploads(ctx, row.attachments);
}

/** A draft Whisk sent or discarded leaves Gmail's Drafts too. */
export async function retireGmailDraft(ctx: Ctx, account: Doc<"accounts">, draft: Doc<"drafts">): Promise<void> {
  if (!draft.gmail_message_id) return;
  await enqueueOutbound(ctx, account, "modify", { op: "deleteDraft", message_gmail_id: draft.gmail_message_id });
  await schedulePump(ctx, account);
}

/** Free the uploads a draft held that its replacement no longer names. */
export async function freeUploads(
  ctx: { storage: MutationCtx["storage"] },
  before: readonly OutgoingAttachment[] | undefined,
  after: readonly OutgoingAttachment[] = [],
): Promise<void> {
  const kept = new Set(after.map((f) => f.storage_id).filter(Boolean));
  for (const f of before ?? []) {
    if (f.storage_id && !kept.has(f.storage_id)) await ctx.storage.delete(f.storage_id);
  }
}
