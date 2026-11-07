import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { validateActions } from "../filters";
import { liveClusters } from "../clusters";
import { rowsForToken } from "../lib/auth";

// Default-runtime helpers the filter actions (Node runtime) call for data
// they cannot read themselves.

/** The names a filter sentence may point at: the person's Gmail labels and
 *  their live topics. */
export const labelNames = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const rows = await ctx.db
      .query("labels")
      .withIndex("by_account", (q) => q.eq("account_id", accountId))
      .collect();
    return {
      labels: rows.filter((l) => !l.deleted && l.kind === "user").map((l) => l.name).sort(),
      topics: (await liveClusters(ctx, accountId)).map((c) => c.name).sort(),
    };
  },
});

export const ownerAddress = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => (await ctx.db.get(accountId))?.email ?? "",
});

/** Model calls a person can start by hand (read a filter, preview it, run
 *  it, regroup) per mailbox per hour. Enough for a busy afternoon of tuning,
 *  far too few for a script to burn through. */
export const MODEL_BUDGET_PER_HOUR = 120;

/** Take `cost` from the mailbox's hourly budget or refuse with a plain
 *  reason. Scheduled work (new mail, auto-grouping) does not draw on it. */
export async function spendModelBudget(ctx: { db: MutationCtx["db"] }, account: Doc<"accounts">, cost: number): Promise<void> {
  const now = Date.now();
  const fresh = !account.ai_window_start || account.ai_window_start < now - 3600_000;
  const spent = fresh ? 0 : account.ai_window_spent ?? 0;
  if (spent + cost > MODEL_BUDGET_PER_HOUR) throw new Error("This mailbox has used its hour of on-demand AI. Try again in a little while.");
  await ctx.db.patch(account._id, { ai_window_start: fresh ? now : account.ai_window_start, ai_window_spent: spent + cost });
}

export const takeModelBudget = internalMutation({
  args: {
    accountId: v.id("accounts"),
    cost: v.number(),
    /** Charge only when this token is a connected app's (lib/actionAuth
     *  chargeAppModelCall). Unset: charge the caller whoever they are. */
    appToken: v.optional(v.string()),
  },
  handler: async (ctx, { accountId, cost, appToken }) => {
    if (appToken !== undefined && !(await rowsForToken(ctx, appToken)).some((r) => r.app_id)) return;
    const account = await ctx.db.get(accountId);
    if (!account) throw new Error("No such mailbox");
    await spendModelBudget(ctx, account, cost);
  },
});

/** Validate a parsed action list against the account (labels exist, lanes
 *  are real). Throws with the reason. */
export const checkActions = internalQuery({
  args: { accountId: v.id("accounts"), actions: v.any() },
  handler: async (ctx, { accountId, actions }) => {
    return await validateActions(ctx, accountId, actions);
  },
});
