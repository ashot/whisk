import { v } from "convex/values";
import { mutation, MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { requireAccounts } from "../lib/auth";

export async function seedDemoCalendar(ctx: Pick<MutationCtx, "db">, accountId: Id<"accounts">, email: string, now: number) {
  const account = await ctx.db.get(accountId);
  if (!account || account.provider !== "demo" || account.calendar_demo_seeded) return false;
  const existing = await ctx.db.query("events").withIndex("by_account_updated", q => q.eq("account_id", accountId)).first();
  await ctx.db.patch(accountId, { calendar_demo_seeded: true, calendar_synced_at: now, updated_at: now });
  if (existing) return false;
  for (const calendar of [
    { google_id: email, summary: "Work", color: "#527c8c", primary: true },
    { google_id: `personal-${email}`, summary: "Personal", color: "#b68551", primary: false },
  ]) {
    const found = await ctx.db.query("calendars").withIndex("by_account_google", q =>
      q.eq("account_id", accountId).eq("google_id", calendar.google_id)).unique();
    if (!found) await ctx.db.insert("calendars", {
      account_id: accountId, ...calendar, selected: true, access_role: "owner", time_zone: "America/New_York", updated_at: now,
    });
  }
  const day = Math.floor(now / 86400000) * 86400000;
  const guests = [
    { email, name: "Nora Adeyemi", self: true, response_status: "accepted" },
    { email: "theo@driftwork.io", name: "Theo Brandt", organizer: true, response_status: "accepted" },
    { email: "priya@driftwork.io", name: "Priya Raman", response_status: "accepted" },
  ];
  const fixtures = [
    { offset: -1, hour: 14, minutes: 45, summary: "Composer review", invited: true },
    { offset: 0, hour: 13, minutes: 25, summary: "Team check-in", invited: true },
    { offset: 0, hour: 14, minutes: 90, summary: "Focus: the attachment retry", description: "A quiet block to finish the retry path and write up the findings." },
    { offset: 0, hour: 17, minutes: 45, summary: "Lunch with Hannah", personal: true, location: "The corner café" },
    { offset: 0, hour: 18, minutes: 60, summary: "Design critique with Priya", invited: true, description: "Bring the composer prototypes and the latest keyboard flow." },
    { offset: 0, hour: 18.5, minutes: 30, summary: "Optional: customer stories", invited: true, response: "declined" as const },
    { offset: 1, hour: 13, minutes: 25, summary: "Team check-in", invited: true },
    { offset: 1, hour: 15, minutes: 60, summary: "Identity workshop with Sofía", invited: true, response: "tentative" as const },
    { offset: 1, hour: 20, minutes: 60, summary: "Walk by the river", personal: true },
    { offset: 2, hour: 0, minutes: 1440, summary: "Hannah’s birthday", personal: true, allDay: true },
    { offset: 2, hour: 14, minutes: 120, summary: "Focus: weekly numbers" },
    { offset: 2, hour: 18, minutes: 30, summary: "Customer conversation", invited: true, response: "needsAction" as const },
    { offset: 3, hour: 13, minutes: 25, summary: "Team check-in", invited: true },
    { offset: 3, hour: 16, minutes: 60, summary: "October offsite planning", invited: true },
    { offset: 4, hour: 14, minutes: 90, summary: "Write: what we learned this week" },
    { offset: 4, hour: 19, minutes: 45, summary: "Friday show and tell", invited: true },
    { offset: 5, hour: 14, minutes: 120, summary: "Farmers market", personal: true },
    { offset: 6, hour: 0, minutes: 2880, summary: "A couple of days away", personal: true, allDay: true },
  ];
  for (const [i, fixture] of fixtures.entries()) {
    const calendarId = fixture.personal ? `personal-${email}` : email;
    const start = day + fixture.offset * 86400000 + fixture.hour * 3600000;
    await ctx.db.insert("events", {
      account_id: accountId, calendar_google_id: calendarId, google_id: `demo-event-${i + 1}`,
      summary: fixture.summary, description: fixture.description, location: fixture.location,
      start, end: start + fixture.minutes * 60000, all_day: !!fixture.allDay, status: "confirmed",
      organizer: fixture.invited ? { email: "theo@driftwork.io", name: "Theo Brandt" } : { email: calendarId, name: "Nora Adeyemi", self: true },
      attendees: fixture.invited ? guests.map(a => a.self ? { ...a, response_status: fixture.response ?? "accepted" } : a) : [],
      my_response: fixture.invited ? fixture.response ?? "accepted" : undefined,
      updated_at: now,
    });
  }
  return true;
}

export const ensureDemoCalendars = mutation({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, { token }) => {
    const accounts = await requireAccounts(ctx, token);
    let seeded = 0;
    for (const account of accounts) {
      if (account.provider === "demo" && await seedDemoCalendar(ctx, account._id, account.email, Date.now())) seeded++;
    }
    return { seeded };
  },
});
