import { v } from "convex/values";
import { internalMutation, internalQuery, ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { hashToken } from "../lib/auth";
import { GmailApiError } from "../gmail/api";
import { EventWrite, conferenceUrl, deleteEvent, getEvent, insertEvent, parseGoogleEvent, patchEvent, toGoogleEventBody } from "./api";
import { calendarFor, canEdit, eventFor, writable } from "./write";

export type CalendarOp = (
  | { op: "insert"; client_id: string; calendar_google_id: string; input?: EventWrite }
  | { op: "patch"; calendar_google_id: string; google_id: string; patch: Record<string, unknown> }
  | { op: "rsvp"; calendar_google_id: string; google_id: string; response: string }
  | { op: "delete"; calendar_google_id: string; google_id: string }
) & { event_id?: Id<"events"> };

export async function runCalendarOutbound(ctx: Pick<ActionCtx, "runQuery" | "runMutation">, accountId: Id<"accounts">, accessToken: string, payload: CalendarOp): Promise<void> {
  const target = await ctx.runQuery(internal.calendar.outbound.eventForOp, {
    accountId, calendar_google_id: payload.calendar_google_id,
    google_id: payload.op === "insert" ? `local-event-${payload.client_id}` : payload.google_id,
  });
  if (!target) return;
  const { row, calendar } = target;
  if (payload.op === "rsvp") {
    const self = row.attendees.find(a => a.self && !a.organizer);
    if (!writable(calendar) || row.organizer?.self || !self) throw new Error("This event is no longer an invitation to you");
    if (row.deleted) return;
    await patchEvent(accessToken, calendar.google_id, row.google_id, {
      attendeesOmitted: true, attendees: [{ email: self.email, responseStatus: payload.response }],
    });
    return;
  }
  if (!canEdit(row, calendar)) throw new Error("This event is no longer editable by you");
  if (payload.op === "insert") {
    if (row.deleted) return;
    const googleId = row.google_id.startsWith("local-event-")
      ? await hashToken(`${accountId}:${calendar.google_id}:${payload.client_id}`) : row.google_id;
    let created;
    try {
      created = await insertEvent(accessToken, calendar.google_id, {
        id: googleId,
        ...toGoogleEventBody(payload.input ?? { ...row, attendees: row.attendees.map(a => a.email) }),
      });
    } catch (caught) {
      if (!(caught instanceof GmailApiError) || caught.status !== 409) throw caught;
      created = await getEvent(accessToken, calendar.google_id, googleId);
    }
    const parsed = parseGoogleEvent(created, calendar.google_id);
    if (!parsed) throw new Error("Google returned an invalid created event");
    await ctx.runMutation(internal.calendar.outbound.applyInsertResult, {
      accountId, client_id: payload.client_id, event: parsed, written_at: row.local_written_at,
    });
    return;
  }
  if (payload.op === "patch") {
    if (row.deleted) return;
    const body = toGoogleEventBody(payload.patch);
    let etag: string | undefined;
    if (payload.patch.attendees !== undefined) {
      const remote = await getEvent(accessToken, calendar.google_id, row.google_id);
      etag = remote.etag;
      const wanted = payload.patch.attendees as string[];
      const roster = remote.attendees ?? [];
      body.attendees = [
        ...wanted.map(email => roster.find(a => a.email?.toLowerCase() === email.toLowerCase()) ?? { email }),
        ...roster.filter(a => a.resource && !wanted.some(email => email.toLowerCase() === a.email?.toLowerCase())),
      ];
    }
    await patchEvent(accessToken, calendar.google_id, row.google_id, body, etag);
    return;
  }
  try {
    await deleteEvent(accessToken, calendar.google_id, row.google_id);
  } catch (caught) {
    if (caught instanceof GmailApiError && [404, 410].includes(caught.status)) return;
    throw caught;
  }
}

export const eventForOp = internalQuery({
  args: { accountId: v.id("accounts"), calendar_google_id: v.string(), google_id: v.string() },
  handler: async (ctx, args): Promise<{ row: Doc<"events">; calendar: Doc<"calendars"> } | null> => {
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    const calendar = await calendarFor(ctx, account, args.calendar_google_id);
    const row = await eventFor(ctx, args.accountId, calendar.google_id, args.google_id);
    return row ? { row, calendar } : null;
  },
});

export const applyInsertResult = internalMutation({
  args: { accountId: v.id("accounts"), client_id: v.string(), event: v.any(), written_at: v.optional(v.number()) },
  handler: async (ctx, { accountId, client_id, event }) => {
    if (!await ctx.db.get(accountId) || !event) return { rekeyed: false };
    const local = await ctx.db.query("events").withIndex("by_account_client", q =>
      q.eq("account_id", accountId).eq("client_id", client_id)).unique();
    if (!local || local.calendar_google_id !== event.calendar_google_id) return { rekeyed: false };
    const synced = await ctx.db.query("events").withIndex("by_account_google", q =>
      q.eq("account_id", accountId).eq("calendar_google_id", event.calendar_google_id).eq("google_id", event.google_id)).unique();
    if (synced && synced._id !== local._id) {
      await ctx.db.patch(synced._id, { google_id: `superseded-${synced._id}`, deleted: true, updated_at: Date.now() });
    }
    await ctx.db.patch(local._id, {
      google_id: event.google_id, ical_uid: event.ical_uid, html_link: event.html_link,
      native_conference_url: event.native_conference_url,
      conference_url: conferenceUrl({ id: event.google_id, hangoutLink: event.native_conference_url, location: local.location, description: local.description }), updated_at: Date.now(),
    });
    return { rekeyed: true };
  },
});
