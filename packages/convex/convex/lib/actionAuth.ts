import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { ScopeNeed } from "./apps";

// Public actions cannot read the database, so they resolve their caller
// through an internal query (search.accountsForToken, or a context query of
// their own that calls lib/auth). After that check passes, `recordUse` stamps
// the token's last use, which is the only way a read-only caller (an app that
// searches and summarizes) shows a fresh "last used" in Whisk's Settings.

/** Record a use of `token` once the action's access check has passed. */
export async function recordUse(ctx: ActionCtx, token: string | undefined): Promise<void> {
  if (token) await ctx.runMutation(internal.connect.touchToken, { token });
}

/** The caller's accounts for an action that needs `scope`, with the use recorded. */
export async function actionAccounts(
  ctx: ActionCtx,
  args: { token?: string; accountId?: Id<"accounts">; scope: ScopeNeed },
): Promise<Array<{ _id: Id<"accounts">; provider: Doc<"accounts">["provider"] }>> {
  const accounts = await ctx.runQuery(internal.search.accountsForToken, {
    token: args.token,
    accountId: args.accountId,
    scope: typeof args.scope === "string" ? args.scope : [...args.scope],
  });
  await recordUse(ctx, args.token);
  return accounts;
}

/**
 * Charge one model call to the mailbox's hourly budget when `token` is a
 * connected app's. Whisk's own clients start drafts, suggestions and
 * summaries as the person reads, so those draw on nothing for them; an app
 * is a server that could loop, so each of its calls counts. Calls a person
 * starts by hand (rewrite, filters) charge every caller through
 * takeModelBudget directly.
 */
export async function chargeAppModelCall(
  ctx: ActionCtx,
  token: string | undefined,
  accountId: Id<"accounts">,
): Promise<void> {
  if (token) {
    await ctx.runMutation(internal.ai.filterSupport.takeModelBudget, { accountId, cost: 1, appToken: token });
  }
}
