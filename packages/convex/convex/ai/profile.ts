import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { readableBody } from "./mailText";
import { SYSTEM_LABEL_IDS } from "../lib/threads";
import { isOwnAddress } from "@mail/shared/src/lib/sendAs";

// The voice profile: a handful of plain-text style memories distilled from
// the owner's own sent mail. Runs once when a mailbox finishes backfilling
// (and on demo seed); re-running replaces the previous distillation. The
// output is ordinary memory rows — visible, deletable, nothing hidden.

const SAMPLE_SCAN = 600;
const SAMPLE_KEEP = 24;

export const sentSamples = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const account = await ctx.db.get(accountId);
    if (!account) return [];
    const samples: string[] = [];
    let scanned = 0;
    for await (const message of ctx.db
      .query("messages")
      .withIndex("by_account_updated", (q) => q.eq("account_id", accountId))
      .order("desc")) {
      if (++scanned > SAMPLE_SCAN || samples.length >= SAMPLE_KEEP) break;
      if (message.deleted) continue;
      if (!message.label_ids.includes(SYSTEM_LABEL_IDS.SENT)) continue;
      if (!isOwnAddress(account, message.from.email)) continue;
      const body = readableBody(message, 700);
      if (body.length < 40) continue; // "thanks!" teaches nothing
      samples.push(body);
    }
    return samples;
  },
});

export const replaceStyleMemories = internalMutation({
  args: { accountId: v.id("accounts"), texts: v.array(v.string()) },
  handler: async (ctx, { accountId, texts }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("memories")
      .withIndex("by_account", (q) => q.eq("account_id", accountId))
      .collect();
    for (const memory of existing) {
      if (memory.kind === "style" && memory.source === "sent" && !memory.deleted) {
        await ctx.db.patch(memory._id, { deleted: true, updated_at: now });
      }
    }
    for (const text of texts) {
      await ctx.db.insert("memories", {
        account_id: accountId,
        kind: "style",
        text,
        source: "sent",
        created_at: now,
        updated_at: now,
      });
    }
  },
});

