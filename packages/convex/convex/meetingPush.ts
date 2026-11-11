// Meetings become a push to the phone here. Once a minute, for every person
// with a phone, the meetings entering their lead window ("5 minutes before",
// their calendar setting) are claimed and pushed. The rules are the ones the
// desktop alert runs (@mail/shared/src/lib/meetingAlerts): same calendars,
// same declines, same quiet hours, read on the phone's own clock. Claimed
// before sending, so a retry or an overlapping tick never pushes twice; a
// push that fails is gone, like mail pushes.

import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { createExpoTransport, type PushMessage, type PushTarget } from "@platform/push/transports";
import { normalizePrefs } from "@mail/shared/src/lib/notifications";
import { calendarPreferences } from "@mail/shared/src/lib/calendar";
import {
  STARTING_GRACE_MS,
  meetingKey,
  meetingPreferences,
  meetingStage,
  shouldAlertMeeting,
  upcomingMeetings,
} from "@mail/shared/src/lib/meetingAlerts";
import type { Calendar, CalendarEvent } from "@mail/shared/src/lib/calendarTypes";
import { meetingPush, wallClock } from "./lib/pushPlan";
import { hasCalendarScope } from "./gmail/oauth";

type Batch = { devices: PushTarget[]; messages: PushMessage[] };

export const claimDue = internalMutation({
  args: {},
  handler: async (ctx): Promise<Batch[]> => {
    const now = Date.now();
    // Over meetings drop their claims; the index keeps this to what expired.
    for (const old of await ctx.db.query("meeting_pushes").withIndex("by_expires", (q) => q.lt("expires_at", now)).take(100)) {
      await ctx.db.delete(old._id);
    }

    const phonesByUser = new Map<Id<"users">, Doc<"push_devices">[]>();
    for (const phone of await ctx.db.query("push_devices").collect()) {
      phonesByUser.set(phone.user_id, [...(phonesByUser.get(phone.user_id) ?? []), phone]);
    }

    const batches: Batch[] = [];
    for (const [userId, phones] of phonesByUser) {
      const state = await ctx.db.query("client_state").withIndex("by_user", (q) => q.eq("user_id", userId)).unique();
      const prefs = normalizePrefs(state?.notifications);
      const calendarPrefs = calendarPreferences(state?.calendar);
      const { enabled, minutesBefore } = meetingPreferences(calendarPrefs);
      if (!prefs.enabled || !enabled) continue;

      const accounts = (await ctx.db.query("accounts").withIndex("by_user", (q) => q.eq("user_id", userId)).collect()).filter(
        (a) => a.provider === "demo" || hasCalendarScope(a.scopes),
      );
      const events: Doc<"events">[] = [];
      const calendars: Doc<"calendars">[] = [];
      for (const account of accounts) {
        events.push(
          ...(await ctx.db
            .query("events")
            .withIndex("by_account_start", (q) =>
              q.eq("account_id", account._id).gte("start", now - STARTING_GRACE_MS).lte("start", now + minutesBefore * 60_000),
            )
            .collect()),
        );
        calendars.push(...(await ctx.db.query("calendars").withIndex("by_account", (q) => q.eq("account_id", account._id)).collect()));
      }

      const wall = wallClock(new Date(now), phones.find((p) => p.time_zone)?.time_zone);
      const messages: PushMessage[] = [];
      const due = upcomingMeetings(
        events as unknown as CalendarEvent[],
        calendars as unknown as Calendar[],
        accounts.map((a) => a._id),
        calendarPrefs,
        now,
      );
      for (const event of due) {
        // One push per meeting, as it enters the lead window. The phone's
        // own "starting now" would be a second buzz for the same meeting.
        if (meetingStage(event, now) !== "soon" || !shouldAlertMeeting(event, prefs, now, false, wall)) continue;
        const key = meetingKey(event);
        const claimed = await ctx.db
          .query("meeting_pushes")
          .withIndex("by_user_key", (q) => q.eq("user_id", userId).eq("key", key))
          .unique();
        if (claimed) continue;
        await ctx.db.insert("meeting_pushes", { user_id: userId, key, expires_at: event.end });
        messages.push(meetingPush(event, prefs, now));
      }
      if (messages.length > 0) {
        batches.push({ devices: phones.map((p) => ({ token: p.push_token, platform: p.platform })), messages });
      }
    }
    return batches;
  },
});

export const sendDue = internalAction({
  args: {},
  handler: async (ctx): Promise<{ sent: number }> => {
    const batches: Batch[] = await ctx.runMutation(internal.meetingPush.claimDue, {});
    if (batches.length === 0) return { sent: 0 };
    const transport = createExpoTransport({ accessToken: process.env.EXPO_ACCESS_TOKEN });
    const dead = new Set<string>();
    let sent = 0;
    for (const batch of batches) {
      for (const message of batch.messages) {
        const result = await transport.send(batch.devices, message);
        sent += result.sent;
        for (const token of result.deadTokens) dead.add(token);
        if (result.errors.length) console.warn("[meeting push] errors", result.errors);
      }
    }
    if (dead.size > 0) await ctx.runMutation(internal.push.dropTokens, { tokens: [...dead] });
    return { sent };
  },
});
