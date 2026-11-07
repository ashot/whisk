// Gmail tells the server about new mail here, through Cloud Pub/Sub, so a
// change reaches the phone in seconds instead of on the next poll.
//
// Every mailbox holds a Gmail watch on the topic GMAIL_PUBSUB_TOPIC names. A
// watch lives seven days; the cron renews all of them well inside that, and
// a mailbox that has just connected gets its watch at once. Google then posts
// each change to /gmail/push, gated by the token in the URL, and the receiver
// schedules the same incremental sync the poll runs. The poll stays as the
// backstop for a watch Google dropped.
//
// Without GMAIL_PUBSUB_TOPIC nothing here runs and the poll alone syncs.

import { v } from "convex/values";
import { httpAction, internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { getAccessToken, watchMailbox } from "./api";

/** Renew a mailbox's watch, or start one. Quiet when unconfigured. */
export const watchAccount = internalAction({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }): Promise<{ expiration?: string; skipped?: string }> => {
    const topicName = process.env.GMAIL_PUBSUB_TOPIC;
    if (!topicName) return { skipped: "no-topic" };
    const account = await ctx.runQuery(internal.gmail.sync.accountFor, { accountId });
    if (!account || account.provider !== "gmail") return { skipped: "not-gmail" };
    try {
      const accessToken = await getAccessToken(ctx, accountId);
      const result = await watchMailbox(accessToken, topicName);
      return { expiration: result.expiration };
    } catch (error) {
      // Logged, not retried: the next renewal pass tries again, and the poll
      // keeps the mailbox current meanwhile.
      console.warn("[watch] could not watch mailbox", { accountId: String(accountId), error: String(error) });
      return { skipped: "failed" };
    }
  },
});

/** The cron: every mailbox, every pass. A watch call on a live watch only
 *  moves its expiration, so renewing everything is the simplest way to be
 *  sure nothing lapses. */
export const renewAll = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!process.env.GMAIL_PUBSUB_TOPIC) return { scheduled: 0 };
    const accountIds: Id<"accounts">[] = await ctx.runQuery(internal.gmail.oauth.accountsToSync, {});
    for (const accountId of accountIds) {
      await ctx.scheduler.runAfter(0, internal.gmail.watch.watchAccount, { accountId });
    }
    return { scheduled: accountIds.length };
  },
});

/** Pub/Sub delivered one change. Sync that mailbox now, once: a change that
 *  lands while a sync runs queues one follow-up, and a burst of changes
 *  queues no more than that. */
export const noteChange = internalMutation({
  args: { email: v.string(), historyId: v.string() },
  handler: async (ctx, { email, historyId }) => {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_email", (q) => q.eq("email", email.toLowerCase().trim()))
      .unique();
    if (!account || account.provider !== "gmail" || !account.history_id) return { scheduled: false };
    // Gmail history ids only grow; one at or below the cursor is old news.
    if (BigInt(historyId) <= BigInt(account.history_id)) return { scheduled: false };
    // Only the newest rows: a sync this handler queued is at most a few
    // seconds old, and the table keeps a week of finished jobs.
    const jobs = await ctx.db.system.query("_scheduled_functions").order("desc").take(RECENT_JOBS);
    const queued = jobs.some(
      (job) => job.state.kind === "pending" && isIncremental(job.name) && (job.args[0] as { accountId?: string })?.accountId === account._id,
    );
    if (queued) return { scheduled: false };
    const busy = account.sync_status === "syncing" || account.sync_status === "backfilling";
    await ctx.scheduler.runAfter(busy ? SYNC_FOLLOW_UP_MS : 0, internal.gmail.sync.incremental, { accountId: account._id });
    return { scheduled: true };
  },
});

/** The scheduler names a function by its module path; the runtime writes
 *  the compiled path, the test harness the source one. */
const isIncremental = (name: string) => /^gmail\/sync(\.js)?:incremental$/.test(name);

/** How many of the newest scheduled jobs to look through for a queued sync. */
const RECENT_JOBS = 100;

/** A change during a sync waits this long for the sync to finish. The
 *  incremental it queues reads whatever history is newer than the cursor. */
const SYNC_FOLLOW_UP_MS = 3000;

type PubSubPush = { message?: { data?: string; messageId?: string }; subscription?: string };

/** Google posts here. The URL carries GMAIL_PUSH_TOKEN, which is the whole
 *  check: the topic is private, and the body names only a mailbox and a
 *  cursor. Anything Google should not retry gets a 2xx. */
export const receive = httpAction(async (ctx, request) => {
  const expected = process.env.GMAIL_PUSH_TOKEN;
  if (!expected) return new Response("Gmail push is not configured", { status: 503 });
  const token = new URL(request.url).searchParams.get("token");
  if (token !== expected) return new Response("Forbidden", { status: 403 });
  let change: { emailAddress?: string; historyId?: string | number } = {};
  try {
    const body = (await request.json()) as PubSubPush;
    change = JSON.parse(atob(body.message?.data ?? "")) as typeof change;
  } catch {
    return new Response("Unreadable", { status: 204 });
  }
  if (change.emailAddress && change.historyId !== undefined) {
    await ctx.runMutation(internal.gmail.watch.noteChange, {
      email: change.emailAddress,
      historyId: String(change.historyId),
    });
  }
  return new Response(null, { status: 204 });
});
