import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { requireAccounts } from "./lib/auth";
import { SYSTEM_LABEL_IDS, applyLabelsToThread, threadByGmailId } from "./lib/threads";
import { enqueueOutbound, schedulePump } from "./lib/outbound";

// The read side and the clock for reminders. Arming and canceling live in
// dispatch (they are user gestures); this file answers "what is armed?" and
// fires what has come due.

export const listReminders = query({
  args: { token: v.optional(v.string()), since: v.optional(v.number()) },
  handler: async (ctx, { token, since }) => {
    const accounts = await requireAccounts(ctx, token, "mail.read");
    const out = [];
    for (const account of accounts) {
      const rows = await ctx.db
        .query("reminders")
        .withIndex("by_account", (q) =>
          since === undefined
            ? q.eq("account_id", account._id)
            : q.eq("account_id", account._id).gt("updated_at", since),
        )
        .collect();
      out.push(...rows);
    }
    return out;
  },
});

/** Cron: surface everything that has come due. A snooze returns to the inbox;
 *  a follow-up watch fires only if nobody replied — a reply resolves it
 *  quietly. Threads return unread so they carry weight in the inbox. */
export const fireDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("reminders")
      .withIndex("by_status_time", (q) =>
        q.eq("status", "armed").lte("remind_at", now),
      )
      .take(100);

    let fired = 0;
    for (const reminder of due) {
      const account = await ctx.db.get(reminder.account_id);
      if (!account) {
        await ctx.db.patch(reminder._id, { status: "canceled", updated_at: now });
        continue;
      }
      const thread = await threadByGmailId(
        ctx,
        reminder.account_id,
        reminder.thread_gmail_id,
      );
      if (!thread || thread.deleted) {
        await ctx.db.patch(reminder._id, { status: "canceled", updated_at: now });
        continue;
      }

      // Someone answered while we watched: the loop closed itself.
      if (reminder.kind === "followup" && thread.last_at > reminder.baseline_last_at) {
        await ctx.db.patch(reminder._id, { status: "resolved", updated_at: now });
        continue;
      }

      const add = [SYSTEM_LABEL_IDS.INBOX, SYSTEM_LABEL_IDS.UNREAD];
      const { messageGmailIds } = await applyLabelsToThread(
        ctx,
        reminder.account_id,
        reminder.thread_gmail_id,
        add,
        [],
      );
      await enqueueOutbound(ctx, account, "modify", {
        op: "modify",
        thread_gmail_ids: [reminder.thread_gmail_id],
        message_gmail_ids: messageGmailIds,
        add_label_ids: add,
        remove_label_ids: [],
      });
      await schedulePump(ctx, account);
      await ctx.db.patch(reminder._id, { status: "fired", updated_at: now });
      fired++;
    }
    return { due: due.length, fired };
  },
});
