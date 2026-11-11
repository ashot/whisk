import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./auth.ts": () => import("./auth"),
  "./demo.ts": () => import("./demo"),
  "./meetingPush.ts": () => import("./meetingPush"),
  "./push.ts": () => import("./push"),
};

/** A demo person with a phone, one calendar, and one meeting `startsIn` ms out. */
async function personWithMeeting(startsIn: number, patch: Record<string, unknown> = {}) {
  const t = convexTest(schema, modules);
  const { accountId } = await t.mutation(api.demo.seed, {});
  const now = Date.now();
  await t.run(async (ctx) => {
    const account = (await ctx.db.get(accountId))!;
    await ctx.db.insert("push_devices", { user_id: account.user_id!, push_token: "ExponentPushToken[x]", platform: "ios", created_at: now, updated_at: now });
    await ctx.db.insert("calendars", { account_id: accountId, google_id: "work", summary: "Work", access_role: "owner", updated_at: now });
    await ctx.db.insert("events", {
      account_id: accountId,
      calendar_google_id: "work",
      google_id: "g1",
      summary: "Design review",
      start: now + startsIn,
      end: now + startsIn + 30 * 60_000,
      all_day: false,
      status: "confirmed",
      attendees: [],
      conference_url: "https://meet.google.com/abc-defg-hij",
      updated_at: now,
      ...patch,
    });
  });
  return t;
}

describe("meeting pushes", () => {
  test("a meeting entering the lead window is pushed once, joinable from the push", async () => {
    const t = await personWithMeeting(4 * 60_000);
    const [batch] = await t.mutation(internal.meetingPush.claimDue, {});
    expect(batch.devices).toEqual([{ token: "ExponentPushToken[x]", platform: "ios" }]);
    expect(batch.messages).toHaveLength(1);
    expect(batch.messages[0]).toMatchObject({
      body: "Starts in 4 minutes · Tap to join",
      sound: "meeting-push.wav",
      interruptionLevel: "time-sensitive",
      data: { kind: "meeting", join: "https://meet.google.com/abc-defg-hij" },
    });
    // The next tick finds it claimed.
    expect(await t.mutation(internal.meetingPush.claimDue, {})).toEqual([]);
  });

  test("not yet in the window, declined, or with meeting alerts off: no push", async () => {
    expect(await (await personWithMeeting(20 * 60_000)).mutation(internal.meetingPush.claimDue, {})).toEqual([]);
    expect(await (await personWithMeeting(4 * 60_000, { my_response: "declined" })).mutation(internal.meetingPush.claimDue, {})).toEqual([]);
    const off = await personWithMeeting(4 * 60_000);
    await off.run(async (ctx) => {
      const state = (await ctx.db.query("client_state").first())!;
      await ctx.db.patch(state._id, { calendar: { meetings: { enabled: false } } });
    });
    expect(await off.mutation(internal.meetingPush.claimDue, {})).toEqual([]);
  });

  test("a longer lead time set on the calendar is honored", async () => {
    const t = await personWithMeeting(14 * 60_000);
    await t.run(async (ctx) => {
      const state = (await ctx.db.query("client_state").first())!;
      await ctx.db.patch(state._id, { calendar: { meetings: { minutesBefore: 15 } } });
    });
    const [batch] = await t.mutation(internal.meetingPush.claimDue, {});
    expect(batch.messages[0].body).toBe("Starts in 14 minutes · Tap to join");
  });
});
