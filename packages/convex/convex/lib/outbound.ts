import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { applyLabelsToThread } from "./threads";

/** Rows created by a local write carry ids Google has never seen. */
export function isLocalId(id: string): boolean {
  return id.startsWith("local-");
}

export type OutboundCtx = {
  db: MutationCtx["db"];
  scheduler: MutationCtx["scheduler"];
};

/**
 * Queue an op for Gmail. Demo accounts have no upstream, so their rows land
 * already `done` — the queue stays a truthful record of what happened without
 * ever waking the pump.
 */
export async function enqueueOutbound(
  ctx: OutboundCtx,
  account: Doc<"accounts">,
  kind: "modify" | "send" | "calendar",
  payload: Record<string, unknown>,
): Promise<Id<"outbound">> {
  const now = Date.now();
  const isDemo = account.provider === "demo";
  return await ctx.db.insert("outbound", {
    account_id: account._id,
    kind,
    payload,
    status: isDemo ? "done" : "queued",
    attempts: 0,
    created_at: now,
    updated_at: now,
  });
}

export async function schedulePump(ctx: OutboundCtx, account: Doc<"accounts">) {
  if (account.provider === "demo") return;
  await ctx.scheduler.runAfter(0, internal.gmail.pump.pump, {
    accountId: account._id,
  });
}

/** Change a thread's labels the way a hand gesture does: the local rows
 *  first, then one modify op for Gmail. Returns false when the thread is
 *  unknown. */
export async function modifyThreadLabels(
  ctx: OutboundCtx,
  account: Doc<"accounts">,
  threadGmailId: string,
  add: readonly string[],
  remove: readonly string[],
): Promise<boolean> {
  const { thread, messageGmailIds } = await applyLabelsToThread(ctx, account._id, threadGmailId, add, remove);
  if (!thread) return false;
  await enqueueOutbound(ctx, account, "modify", {
    op: "modify",
    thread_gmail_ids: [threadGmailId],
    message_gmail_ids: messageGmailIds,
    add_label_ids: [...add],
    remove_label_ids: [...remove],
  });
  return true;
}
