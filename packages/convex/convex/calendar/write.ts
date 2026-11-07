import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { hashToken } from "../lib/auth";
import { enqueueOutbound, schedulePump } from "../lib/outbound";
import { hasCalendarScope } from "../gmail/oauth";
import { EventWrite, conferenceUrl } from "./api";
import { scheduleReconcile } from "./sync";

type Ctx = Pick<MutationCtx, "db" | "scheduler">;
type ReadCtx = Pick<QueryCtx, "db">;

export function writable(calendar: Doc<"calendars">) {
  return !calendar.deleted && ["owner", "writer"].includes(calendar.access_role);
}

export function canEdit(event: Doc<"events">, calendar: Doc<"calendars">) {
  return writable(calendar) && !event.recurring_event_id && !event.recurring &&
    (event.organizer?.self === true || event.organizer?.email === calendar.google_id);
}

function boundedText(value: unknown, name: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw new Error(`${name} must be ${required ? "nonempty and " : ""}at most ${max} characters`);
  }
  return value.trim();
}

export function validateEvent(input: Record<string, unknown>): EventWrite {
  const summary = boundedText(input.summary, "Title", 500, true);
  const { start, end, all_day } = input;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) ||
      start < 0 || end > 253402300799999 || end <= start) throw new Error("Event times must be finite, ordered, and have a nonzero duration");
  if (typeof all_day !== "boolean") throw new Error("all_day must be a boolean");
  if (all_day && (start % 86400000 !== 0 || end % 86400000 !== 0)) throw new Error("All-day dates must be UTC midnight with an exclusive end date");
  const guests = input.attendees ?? [];
  if (!Array.isArray(guests) || guests.length > 100) throw new Error("At most 100 guests are supported");
  const attendees = guests.map((email) => {
    if (typeof email !== "string" || email.length > 254 || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email.trim())) throw new Error("Invalid guest email");
    return email.trim().toLowerCase();
  });
  return {
    summary, start, end, all_day,
    description: input.description === undefined ? undefined : boundedText(input.description, "Description", 20000),
    location: input.location === undefined ? undefined : boundedText(input.location, "Location", 1000),
    attendees: [...new Set(attendees)],
  };
}

export async function calendarFor(ctx: ReadCtx, account: Doc<"accounts">, googleId: unknown) {
  if (account.provider !== "demo" && !hasCalendarScope(account.scopes)) throw new Error("Reconnect this account to enable Calendar");
  if (typeof googleId !== "string" || !googleId) throw new Error("calendar_google_id is required");
  const calendar = await ctx.db.query("calendars").withIndex("by_account_google", q =>
    q.eq("account_id", account._id).eq("google_id", googleId)).unique();
  if (!calendar || calendar.deleted) throw new Error("No such calendar");
  return calendar;
}

export async function eventFor(ctx: ReadCtx, accountId: Id<"accounts">, calendarId: string, googleId: string) {
  if (googleId.startsWith("local-event-")) {
    const row = await ctx.db.query("events").withIndex("by_account_client", q =>
      q.eq("account_id", accountId).eq("client_id", googleId.slice(12))).unique();
    if (row?.calendar_google_id === calendarId) return row;
    return null;
  }
  return await ctx.db.query("events").withIndex("by_account_google", q =>
    q.eq("account_id", accountId).eq("calendar_google_id", calendarId).eq("google_id", googleId)).unique();
}

async function queue(ctx: Ctx, account: Doc<"accounts">, event: Doc<"events">, payload: Record<string, unknown>) {
  const id = await enqueueOutbound(ctx, account, "calendar", {
    ...payload, event_id: event._id, calendar_google_id: event.calendar_google_id,
  });
  await ctx.db.patch(event._id, {
    pending_outbound: account.provider === "demo" ? undefined : id,
    local_written_at: Math.max(Date.now(), (event.local_written_at ?? 0) + 1), updated_at: Date.now(),
  });
  if (account.provider !== "demo") await scheduleReconcile(ctx, (await ctx.db.get(event._id))!);
  await schedulePump(ctx, account);
}

export async function createEvent(ctx: Ctx, { account }: { account: Doc<"accounts"> }, args: any) {
  const calendar = await calendarFor(ctx, account, args?.calendar_google_id);
  if (!writable(calendar)) throw new Error("Calendar is read-only");
  const clientId = boundedText(args?.client_id, "client_id", 200, true);
  const input = validateEvent(args);
  const fingerprint = await hashToken(JSON.stringify({ ...input, description: input.description ?? "", location: input.location ?? "", attendees: [...(input.attendees ?? [])].sort() }));
  const existing = await ctx.db.query("events").withIndex("by_account_client", q =>
    q.eq("account_id", account._id).eq("client_id", clientId)).unique();
  if (existing) {
    if (existing.calendar_google_id !== calendar.google_id) throw new Error("client_id already belongs to another calendar");
    if (existing.create_fingerprint !== fingerprint) throw new Error("This draft was already created with different or unverified details. Open the existing event to apply your changes, or start a new draft to create a separate event.");
    return { event_id: existing._id, google_id: existing.google_id, client_id: clientId };
  }
  const googleId = await hashToken(`${account._id}:${calendar.google_id}:${clientId}`);
  const id = await ctx.db.insert("events", {
    ...input, attendees: (input.attendees ?? []).map(email => ({ email, response_status: "needsAction" })),
    account_id: account._id, calendar_google_id: calendar.google_id, google_id: googleId,
    client_id: clientId, create_fingerprint: fingerprint, organizer: { email: calendar.google_id, self: true }, status: "confirmed",
    conference_url: conferenceUrl({ id: googleId, location: input.location, description: input.description }),
    updated_at: Date.now(),
  });
  await queue(ctx, account, (await ctx.db.get(id))!, { op: "insert", client_id: clientId, input });
  return { event_id: id, google_id: googleId, client_id: clientId };
}

async function target(ctx: Ctx, account: Doc<"accounts">, args: any) {
  const calendar = await calendarFor(ctx, account, args?.calendar_google_id);
  if (typeof args?.google_id !== "string") throw new Error("google_id is required");
  const event = await eventFor(ctx, account._id, calendar.google_id, args.google_id);
  if (!event) throw new Error("No such event");
  return { calendar, event };
}

export async function updateEvent(ctx: Ctx, { account }: { account: Doc<"accounts"> }, args: any) {
  const { calendar, event } = await target(ctx, account, args);
  if (!canEdit(event, calendar)) throw new Error("Only the organizer can edit a non-recurring event in a writable calendar");
  if (event.deleted) throw new Error("Event was deleted");
  const patch = args.patch ?? args;
  const fields = ["summary", "description", "location", "start", "end", "all_day", "attendees"] as const;
  const changes = Object.fromEntries(fields.filter(k => patch[k] !== undefined).map(k => [k, patch[k]]));
  const input = validateEvent({ ...event, attendees: [], ...changes });
  const outgoing = Object.fromEntries(Object.keys(changes).map(k => [k, input[k as keyof EventWrite]]));
  if (["start", "end", "all_day"].some(k => k in changes)) Object.assign(outgoing, { start: input.start, end: input.end, all_day: input.all_day });
  await ctx.db.patch(event._id, {
    ...input,
    attendees: "attendees" in changes ? input.attendees!.map(email => event.attendees.find(a => a.email.toLowerCase() === email) ?? { email, response_status: "needsAction" }) : event.attendees,
    conference_url: conferenceUrl({ id: event.google_id, hangoutLink: event.native_conference_url, location: input.location, description: input.description }),
  });
  await queue(ctx, account, event, { op: "patch", google_id: event.google_id, patch: outgoing });
  return { event_id: event._id, updated: true };
}

export async function deleteEvent(ctx: Ctx, { account }: { account: Doc<"accounts"> }, args: any) {
  const { calendar, event } = await target(ctx, account, args);
  if (!canEdit(event, calendar)) throw new Error("Only the organizer can delete a non-recurring event in a writable calendar");
  if (event.deleted) return { deleted: true };
  await ctx.db.patch(event._id, { deleted: true });
  await queue(ctx, account, event, { op: "delete", google_id: event.google_id });
  return { deleted: true };
}

export async function rsvpEvent(ctx: Ctx, { account }: { account: Doc<"accounts"> }, args: any) {
  const { calendar, event } = await target(ctx, account, args);
  const response = args.response ?? args.my_response;
  if (!["accepted", "tentative", "declined"].includes(response)) throw new Error("Invalid RSVP response");
  if (!writable(calendar) || event.deleted || event.organizer?.self || !event.attendees.some(a => a.self && !a.organizer)) throw new Error("RSVP requires an invitation to you on a writable calendar");
  if (event.my_response === response) return { response };
  await ctx.db.patch(event._id, {
    my_response: response,
    attendees: event.attendees.map(a => a.self ? { ...a, response_status: response } : a),
  });
  await queue(ctx, account, event, { op: "rsvp", google_id: event.google_id, response });
  return { response };
}

export async function retryCalendarWrites(ctx: Ctx, { account }: { account: Doc<"accounts"> }) {
  const rows = await ctx.db.query("outbound").withIndex("by_account_status", q =>
    q.eq("account_id", account._id).eq("status", "error")).collect();
  let retried = 0;
  for (const row of rows) {
    if (row.kind !== "calendar") continue;
    await ctx.db.patch(row._id, { status: "queued", attempts: 0, retry_at: undefined, error: undefined, updated_at: Date.now() });
    const event = row.payload.event_id ? await ctx.db.get(row.payload.event_id as Id<"events">) : null;
    if (event?.account_id === account._id) {
      await ctx.db.patch(event._id, { write_error: undefined, pending_outbound: event.pending_outbound ?? row._id, updated_at: Date.now() });
      await scheduleReconcile(ctx, (await ctx.db.get(event._id))!);
    }
    retried++;
  }
  await ctx.db.patch(account._id, { calendar_write_error: undefined, updated_at: Date.now() });
  await schedulePump(ctx, account);
  return { retried };
}
