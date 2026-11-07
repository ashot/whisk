// New mail becomes a push to the phone here, and nowhere else.
//
// The sync schedules `notifyNewMail` the moment fresh inbound mail lands. The
// query gathers what the rules need (the threads as they are now, the
// person's notification prefs, their topics, their phones); the pure plan in
// lib/pushPlan decides; the action sends through Expo and drops the tokens
// Expo says are dead. Mail whose lane the sync placed itself goes out at once;
// mail the model still has to place, or a filter still has to judge, waits
// for exactly that and no longer. A push at full preview then waits briefly
// for the model's summary of the thread, which becomes its body. Best effort by design: a push that fails is
// logged and gone. The next mail queues its own.

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { createExpoTransport, type PushMessage, type PushTarget } from "@platform/push/transports";
import { MODEL_WAIT_MAX_MS, SUMMARY_WAIT_MS, modelWorkSettled, normalizePrefs, unreadInInbox } from "@mail/shared/src/lib/notifications";
import type { Thread } from "@mail/shared/src/store/types";
import { PUSH_POLL_MS, newMailPushes, pushesWantingSummary, wallClock } from "./lib/pushPlan";
import { viewerUserId } from "./lib/auth";
import { liveFilters } from "./filters";

type Plan = { devices: PushTarget[]; messages: PushMessage[]; summarize?: string[] };

const newMailArgs = {
  accountId: v.id("accounts"),
  threadGmailIds: v.array(v.string()),
  /** When the sync that brought these threads landed. With it, the plan
   *  answers "wait" until the model work that sync started is done. */
  since: v.optional(v.number()),
  /** The model's summaries, once fetched, keyed by thread gmail id. */
  summaries: v.optional(v.record(v.string(), v.string())),
};

export const planNewMail = internalQuery({
  args: newMailArgs,
  handler: async (ctx, { accountId, threadGmailIds, since, summaries }): Promise<Plan | "wait" | null> => {
    const account = await ctx.db.get(accountId);
    if (!account?.user_id) return null;
    const phones = await ctx.db
      .query("push_devices")
      .withIndex("by_user", (q) => q.eq("user_id", account.user_id!))
      .collect();
    if (phones.length === 0) {
      console.log("[push] skipped: no devices", { user: String(account.user_id) });
      return null;
    }
    const state = await ctx.db
      .query("client_state")
      .withIndex("by_user", (q) => q.eq("user_id", account.user_id!))
      .unique();
    const prefs = normalizePrefs(state?.notifications);
    if (!prefs.enabled) {
      console.log("[push] skipped: notifications off", { accountId: String(accountId) });
      return null;
    }
    const threads: Doc<"threads">[] = [];
    for (const gmailId of threadGmailIds) {
      const t = await ctx.db
        .query("threads")
        .withIndex("by_account_gmail", (q) => q.eq("account_id", accountId).eq("gmail_id", gmailId))
        .unique();
      // Still unread and still in the inbox: read or archived from another
      // device in the meantime means it is not news any more.
      if (t && unreadInInbox(t)) threads.push(t);
    }
    if (threads.length === 0) return null;
    if (
      since !== undefined &&
      Date.now() < since + MODEL_WAIT_MAX_MS &&
      !modelWorkSettled({
        threads,
        filters: await liveFilters(ctx, accountId),
        since,
        modelOn: !!process.env.ANTHROPIC_API_KEY,
      })
    ) {
      return "wait";
    }
    const clusters = Object.fromEntries(
      (await ctx.db.query("clusters").withIndex("by_account", (q) => q.eq("account_id", accountId)).collect()).map((c) => [c._id, c]),
    );
    const input = {
      threads: threads as unknown as Thread[],
      prefs,
      me: account,
      clusters,
      now: wallClock(new Date(), phones.find((p) => p.time_zone)?.time_zone),
      summaries,
    };
    const messages = newMailPushes(input);
    if (messages.length === 0) return null;
    return {
      devices: phones.map((p) => ({ token: p.push_token, platform: p.platform })),
      messages,
      summarize: pushesWantingSummary(input, messages),
    };
  },
});

export const notifyNewMail = internalAction({
  args: newMailArgs,
  handler: async (ctx, args): Promise<void> => {
    const settled = async (summaries?: Record<string, string>): Promise<Plan | null> => {
      let p: Plan | "wait" | null = await ctx.runQuery(internal.push.planNewMail, { ...args, summaries });
      while (p === "wait") {
        await new Promise((r) => setTimeout(r, PUSH_POLL_MS));
        p = await ctx.runQuery(internal.push.planNewMail, { ...args, summaries });
      }
      return p;
    };
    let plan = await settled();
    if (plan?.summarize?.length) {
      const summaries: Record<string, string> = await ctx.runAction(internal.ai.actions.summarizeForPush, {
        accountId: args.accountId,
        threadGmailIds: plan.summarize,
        timeoutMs: SUMMARY_WAIT_MS,
      });
      // Planned again rather than patched: mail read while the model wrote
      // no longer earns a push at all.
      if (Object.keys(summaries).length > 0) plan = await settled(summaries);
    }
    if (!plan) return;
    const transport = createExpoTransport({ accessToken: process.env.EXPO_ACCESS_TOKEN });
    const dead = new Set<string>();
    for (const message of plan.messages) {
      const result = await transport.send(plan.devices, message);
      for (const token of result.deadTokens) dead.add(token);
    }
    if (dead.size > 0) await ctx.runMutation(internal.push.dropTokens, { tokens: [...dead] });
  },
});

/** A button on the phone: prove the token is live, independent of new mail. */
export const planTest = internalQuery({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }): Promise<Plan | null> => {
    const userId = await viewerUserId(ctx, token);
    if (!userId) return null;
    const phones = await ctx.db
      .query("push_devices")
      .withIndex("by_user", (q) => q.eq("user_id", userId))
      .collect();
    if (phones.length === 0) return null;
    return {
      devices: phones.map((p) => ({ token: p.push_token, platform: p.platform })),
      messages: [
        {
          title: "Whisk",
          body: "Notifications are working.",
          sound: "default",
          data: { kind: "test" },
          priority: "high",
        },
      ],
    };
  },
});

export const sendTest = action({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }): Promise<{ sent: number; reason?: string; errors: string[] }> => {
    const plan: Plan | null = await ctx.runQuery(internal.push.planTest, { token });
    if (!plan) return { sent: 0, reason: "no-device", errors: [] };
    const transport = createExpoTransport({ accessToken: process.env.EXPO_ACCESS_TOKEN });
    const dead = new Set<string>();
    const errors: string[] = [];
    let sent = 0;
    for (const message of plan.messages) {
      const result = await transport.send(plan.devices, message);
      sent += result.sent;
      errors.push(...result.errors);
      for (const t of result.deadTokens) dead.add(t);
    }
    if (dead.size > 0) await ctx.runMutation(internal.push.dropTokens, { tokens: [...dead] });
    return { sent, errors, reason: sent === 0 ? "expo-rejected" : undefined };
  },
});

/** Expo said these phones are gone (app removed, token rotated). */
export const dropTokens = internalMutation({
  args: { tokens: v.array(v.string()) },
  handler: async (ctx, { tokens }) => {
    for (const token of tokens) {
      const row = await ctx.db.query("push_devices").withIndex("by_token", (q) => q.eq("push_token", token)).unique();
      if (row) await ctx.db.delete(row._id);
    }
  },
});
