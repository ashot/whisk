import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { wipeAccountRowsBatch } from "./lib/accounts";

// The background half of an account disconnect: scrub the mirrored mailbox in
// batches sized to stay well inside mutation limits, rechaining until clean.
// The account row is already gone by the time this runs, so the rows are
// unreachable — this reclaims storage, it does not gate access.

const WIPE_BATCH = 500;

export const wipeRows = internalMutation({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const done = await wipeAccountRowsBatch(ctx, accountId, WIPE_BATCH);
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.accounts.wipeRows, { accountId });
    }
  },
});
