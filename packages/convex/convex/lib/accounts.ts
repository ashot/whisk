import { Doc, Id } from "../_generated/dataModel";
import { WriteCtx } from "./auth";

// Removing an account is two jobs of very different size. The rows that gate
// access (credentials, sessions, the account itself, the orphaned user) are a
// handful and must go atomically with the request; the mirrored mail can be
// thousands of rows and is scrubbed in batches. Both demo.reset and the real
// disconnect share these helpers so the two paths can never diverge.

/** Tables whose rows carry an account_id and hold the bulk of a mailbox. */
export const ACCOUNT_ROW_TABLES = [
  "messages",
  "threads",
  "labels",
  "drafts",
  "outbound",
  "credentials",
  "memories",
  "reminders",
  "thread_ai",
  "clusters",
  "filters",
  "filter_matches",
  "calendars",
  "events",
  // Legacy rows only — modern rows are user-scoped and survive until the
  // user themselves is deleted.
  "client_state",
  "auth_sessions",
] as const;

/**
 * Delete up to `limit` rows owned by the account across the bulk tables.
 * Returns true when nothing was left to delete — the account is clean.
 */
export async function wipeAccountRowsBatch(
  ctx: WriteCtx,
  accountId: Id<"accounts">,
  limit: number,
): Promise<boolean> {
  let budget = limit;
  for (const table of ACCOUNT_ROW_TABLES) {
    if (budget <= 0) return false;
    const rows = await ctx.db
      .query(table)
      .filter((q) => q.eq(q.field("account_id"), accountId))
      .take(budget);
    for (const row of rows) await ctx.db.delete(row._id);
    budget -= rows.length;
  }
  return budget > 0;
}

/**
 * Delete the account row itself and, when it was the user's last account,
 * the user with their sessions and prefs — nothing would resolve through
 * them anymore. Returns whether the user went too, so the caller can tell
 * the client to end its session.
 */
export async function deleteAccountAndMaybeUser(
  ctx: WriteCtx,
  account: Doc<"accounts">,
): Promise<{ userDeleted: boolean }> {
  await ctx.db.delete(account._id);
  if (!account.user_id) return { userDeleted: false };
  const remaining = await ctx.db
    .query("accounts")
    .withIndex("by_user", (q) => q.eq("user_id", account.user_id))
    .first();
  if (remaining) return { userDeleted: false };
  // A user with a Convex Auth identity (a Google sign-in) outlives their
  // last mailbox: disconnecting mail must not delete the login they can
  // still sign in with. Legacy token-only users have nothing left to
  // resolve through and are cleaned up as before.
  const identity = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", account.user_id!))
    .first();
  if (identity) return { userDeleted: false };
  for (const table of ["auth_sessions", "client_state"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_user", (q) => q.eq("user_id", account.user_id))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
  await ctx.db.delete(account.user_id);
  return { userDeleted: true };
}
