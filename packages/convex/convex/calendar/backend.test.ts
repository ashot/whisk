import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { createAuthSession } from "../lib/auth";
import { CALENDAR_SCOPES } from "../gmail/oauth";
import { CalendarOp, runCalendarOutbound } from "./outbound";
import { parseGoogleEvent } from "./api";
import { WINDOW_FUTURE_MS, WINDOW_PAST_MS } from "./sync";
import { sealTokens } from "../lib/credentials";

process.env.WHISK_CREDENTIALS_KEY ??= Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

const modules = {
  "../_generated/api.js": () => import("../_generated/api.js"),
  "../_generated/server.js": () => import("../_generated/server.js"),
  "../auth.ts": () => import("../auth"),
  "../demo.ts": () => import("../demo"),
  "../dispatch.ts": () => import("../dispatch"),
  "../sync.ts": () => import("../sync"),
  "../gmail/sync.ts": () => import("../gmail/sync"),
  "../gmail/oauth.ts": () => import("../gmail/oauth"),
  "../gmail/pump.ts": () => import("../gmail/pump"),
  "../calendar/read.ts": () => import("./read"),
  "../calendar/demo.ts": () => import("./demo"),
  "../calendar/sync.ts": () => import("./sync"),
  "../calendar/outbound.ts": () => import("./outbound"),
};
type Harness = ReturnType<typeof convexTest>;
const originalFetch = globalThis.fetch;
let timers: ReturnType<typeof spyOn>;
beforeEach(() => { timers = spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as any); });
afterEach(() => { globalThis.fetch = originalFetch; timers.mockRestore(); });

async function fixture(provider: "demo" | "gmail" = "demo", t = convexTest(schema, modules)) {
  const data = await t.run(async ctx => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", { email: `${crypto.randomUUID()}@example.org` });
    const accountId = await ctx.db.insert("accounts", { email: "me@example.org", user_id: userId, provider, scopes: [...CALENDAR_SCOPES], sync_status: "idle", updated_at: now });
    const calendarId = await ctx.db.insert("calendars", { account_id: accountId, google_id: "me@example.org", summary: "Work", selected: true, primary: true, access_role: "owner", updated_at: now });
    const token = await createAuthSession(ctx, userId);
    // Stored the way real rows are: sealed and bound to this account.
    if (provider === "gmail") await ctx.db.insert("credentials", { account_id: accountId, ...(await sealTokens(accountId, { access_token: "test", refresh_token: "test" })), expiry: now + 3600000 });
    return { token, accountId, calendarId, userId };
  });
  return { t, ...data };
}
const dispatch = (f: Awaited<ReturnType<typeof fixture>>, action: string, args: Record<string, unknown> = {}) =>
  f.t.mutation(api.dispatch.dispatch, { token: f.token, action, args: { account_id: f.accountId, calendar_google_id: "me@example.org", ...args } });
const create = (f: Awaited<ReturnType<typeof fixture>>, args: Record<string, unknown> = {}) => dispatch(f, "createEvent", {
  client_id: crypto.randomUUID(), summary: "Design review", start: Date.now() + 3600000, end: Date.now() + 7200000, all_day: false, ...args,
});
const rows = <T extends keyof typeof schema.tables>(t: Harness, table: T) => t.run(ctx => ctx.db.query(table).collect());
const event = async (t: Harness, id: Id<"events">) => (await t.run(ctx => ctx.db.get(id)))!;
const queueRows = async (t: Harness) => (await rows(t, "outbound")).filter(r => r.kind === "calendar");
const actionCtx = (t: Harness) => ({ runQuery: t.query.bind(t), runMutation: t.mutation.bind(t) }) as Parameters<typeof runCalendarOutbound>[0];
const googleEvent = (id: string, summary = "Remote event") => ({ id, summary, start: { dateTime: new Date(Date.now() + 3600000).toISOString() }, end: { dateTime: new Date(Date.now() + 7200000).toISOString() }, organizer: { email: "me@example.org", self: true } });
async function syncArgs(f: Awaited<ReturnType<typeof fixture>>) {
  const run = crypto.randomUUID();
  const started = (await f.t.mutation(internal.calendar.sync.claimSync, { accountId: f.accountId, run }))!;
  return { accountId: f.accountId, run, started, full: true, windowStart: started - WINDOW_PAST_MS, windowEnd: started + WINDOW_FUTURE_MS };
}


describe("calendar authenticated dispatch", () => {
  test("create, edit, delete and replay through the public write rail", async () => {
    const f = await fixture();
    const input = { client_id: "stable-id", start: 1800000000000, end: 1800003600000 };
    const made = await create(f, input);
    expect(made.google_id).toMatch(/^[0-9a-f]{64}$/);
    const duplicate = await create(f, input);
    expect(duplicate.event_id).toBe(made.event_id);
    expect(await queueRows(f.t)).toHaveLength(1);
    await dispatch(f, "updateEvent", { google_id: "local-event-stable-id", patch: { summary: "Changed", location: "Room 2" } });
    expect(await event(f.t, made.event_id)).toMatchObject({ summary: "Changed", location: "Room 2" });
    await dispatch(f, "deleteEvent", { google_id: made.google_id });
    await dispatch(f, "deleteEvent", { google_id: made.google_id });
    expect(await queueRows(f.t)).toHaveLength(3);
    expect((await event(f.t, made.event_id)).deleted).toBe(true);
    await expect(dispatch(f, "updateEvent", { google_id: made.google_id, patch: { summary: "No" } })).rejects.toThrow("deleted");
    expect((await queueRows(f.t)).every(r => r.status === "done")).toBe(true);
  });
  test("rejects missing auth, account crossing, and cross-calendar aliases", async () => {
    const f = await fixture();
    const second = await fixture("demo", f.t);
    const made = await create(f, { client_id: "mine" });
    await expect(f.t.query(api.calendar.read.listEvents, {})).rejects.toThrow("Unauthorized");
    await expect(f.t.query(api.calendar.read.listCalendars, { token: "bad" })).rejects.toThrow("Unauthorized");
    await expect(dispatch(second, "deleteEvent", { account_id: f.accountId, google_id: made.google_id })).rejects.toThrow("Unauthorized");
    await expect(dispatch(second, "updateEvent", { google_id: made.google_id, patch: { summary: "stolen" } })).rejects.toThrow("No such event");
    const data = await f.t.query(api.calendar.read.listEvents, { token: second.token });
    expect(data.rows).toHaveLength(0);
    await f.t.run(ctx => ctx.db.insert("calendars", { account_id: f.accountId, google_id: "other", summary: "Other", access_role: "owner", updated_at: Date.now() }));
    await expect(dispatch(f, "deleteEvent", { calendar_google_id: "other", google_id: "local-event-mine" })).rejects.toThrow("No such event");
  });
  test("permission, recurrence, scope and input failures leave no queued write", async () => {
    const f = await fixture();
    const made = await create(f);
    await f.t.run(ctx => ctx.db.patch(f.calendarId, { access_role: "reader" }));
    await expect(create(f)).rejects.toThrow("read-only");
    await expect(dispatch(f, "deleteEvent", { google_id: made.google_id })).rejects.toThrow("organizer");
    await f.t.run(ctx => ctx.db.patch(f.calendarId, { access_role: "owner" }));
    await f.t.run(ctx => ctx.db.patch(made.event_id, { recurring_event_id: "series" }));
    await expect(dispatch(f, "updateEvent", { google_id: made.google_id, patch: { summary: "No" } })).rejects.toThrow("non-recurring");
    await f.t.run(ctx => ctx.db.patch(made.event_id, { recurring_event_id: undefined, organizer: { email: "other@example.org" } }));
    await expect(dispatch(f, "deleteEvent", { google_id: made.google_id })).rejects.toThrow("organizer");
    await expect(create(f, { start: 2, end: 1 })).rejects.toThrow("times");
    await expect(create(f, { attendees: ["oops"] })).rejects.toThrow("email");
    expect(await queueRows(f.t)).toHaveLength(1);
    await f.t.run(ctx => ctx.db.patch(f.accountId, { provider: "gmail", scopes: [] }));
    await expect(create(f)).rejects.toThrow("Reconnect");
  });
  test("RSVP is self-only, works on recurring invitations, and repeats are idempotent", async () => {
    const f = await fixture();
    const made = await create(f);
    await expect(dispatch(f, "rsvpEvent", { google_id: made.google_id, response: "accepted" })).rejects.toThrow("invitation");
    await f.t.run(ctx => ctx.db.patch(made.event_id, {
      organizer: { email: "host@example.org" }, recurring_event_id: "series",
      attendees: [{ email: "me@example.org", self: true, response_status: "needsAction" }, { email: "host@example.org", response_status: "accepted" }], my_response: "needsAction",
    }));
    await dispatch(f, "rsvpEvent", { google_id: made.google_id, response: "declined" });
    await dispatch(f, "rsvpEvent", { google_id: made.google_id, response: "declined" });
    expect(await queueRows(f.t)).toHaveLength(2);
    expect((await event(f.t, made.event_id)).attendees[1].response_status).toBe("accepted");
    await expect(dispatch(f, "rsvpEvent", { google_id: made.google_id, response: "invalid" })).rejects.toThrow("Invalid");
  });
  test("snapshots paginate instead of truncating and retain boundary-straddling events", async () => {
    const f = await fixture();
    const now = Date.now();
    await f.t.run(async ctx => {
      for (let i = 0; i < 2100; i++) await ctx.db.insert("events", {
        account_id: f.accountId, calendar_google_id: "me@example.org", google_id: `many-${i}`, summary: "Many", start: now - WINDOW_PAST_MS - 1000,
        end: now, all_day: false, attendees: [], status: "confirmed", updated_at: now,
      });
    });
    const first = await f.t.query(api.calendar.read.listEvents, { token: f.token, limit: 50 });
    expect(first.rows).toHaveLength(2100);
    expect(first.hasMore).toBe(true);
    const next = await f.t.query(api.calendar.read.listEvents, { token: f.token, since: first.nextSince, limit: 50 });
    expect(next.hasMore).toBe(false);
    expect(next.rows).toHaveLength(0);
    await expect(f.t.query(api.calendar.read.listEvents, { token: f.token, limit: 0 })).rejects.toThrow("limit");
  });
});


describe("calendar outbound races and retries", () => {
  test("lost insert response retries the same provider ID and never replaces a newer edit", async () => {
    const f = await fixture("gmail");
    const made = await create(f, { client_id: "retry" });
    const payload = (await queueRows(f.t))[0].payload as CalendarOp;
    const postIds: string[] = [];
    let posts = 0;
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === "POST") {
        postIds.push(JSON.parse(init.body as string).id);
        if (++posts === 1) throw new Error("connection lost after acceptance");
        return new Response("conflict", { status: 409 });
      }
      await dispatch(f, "updateEvent", { google_id: made.google_id, patch: { summary: "Newer edit" } });
      return Response.json(googleEvent(made.google_id, "Older response"));
    }) as typeof fetch;
    await expect(runCalendarOutbound(actionCtx(f.t), f.accountId, "test", payload)).rejects.toThrow("connection lost");
    await runCalendarOutbound(actionCtx(f.t), f.accountId, "test", payload);
    expect(postIds).toEqual([made.google_id, made.google_id]);
    expect((await event(f.t, made.event_id)).summary).toBe("Newer edit");
    expect(await rows(f.t, "events")).toHaveLength(1);
  });
  test("delete during insert stays deleted and a queued delete resolves the local alias", async () => {
    const f = await fixture("gmail");
    const made = await create(f, { client_id: "race" });
    const payload = (await queueRows(f.t))[0].payload as CalendarOp;
    const calls: string[] = [];
    globalThis.fetch = (async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      if (init?.method === "POST") {
        await dispatch(f, "deleteEvent", { google_id: "local-event-race" });
        return Response.json(googleEvent(made.google_id));
      }
      return new Response("gone", { status: 410 });
    }) as typeof fetch;
    await runCalendarOutbound(actionCtx(f.t), f.accountId, "test", payload);
    expect((await event(f.t, made.event_id)).deleted).toBe(true);
    await runCalendarOutbound(actionCtx(f.t), f.accountId, "test", { op: "delete", google_id: "local-event-race", calendar_google_id: "me@example.org" });
    expect(calls[1]).toContain(`/events/${made.google_id}?`);
    await runCalendarOutbound(actionCtx(f.t), f.accountId, "test", payload);
    expect(calls).toHaveLength(2);
  });
  test("RSVP sends one attendee with attendeesOmitted and never overwrites the roster", async () => {
    const f = await fixture("gmail");
    const made = await create(f);
    await f.t.run(ctx => ctx.db.patch(made.event_id, { organizer: { email: "host@example.org" }, attendees: [{ email: "me@example.org", self: true }, { email: "guest@example.org", response_status: "accepted" }] }));
    let body: any;
    globalThis.fetch = (async (_url, init) => { body = JSON.parse(init!.body as string); return Response.json(googleEvent(made.google_id)); }) as typeof fetch;
    await runCalendarOutbound(actionCtx(f.t), f.accountId, "test", { op: "rsvp", google_id: made.google_id, calendar_google_id: "me@example.org", response: "tentative" });
    expect(body).toEqual({ attendeesOmitted: true, attendees: [{ email: "me@example.org", responseStatus: "tentative" }] });
  });
  test("organizer guest edits retain resources and provider responses with an etag guard", async () => {
    const f = await fixture("gmail");
    const made = await create(f);
    const guest = { email: "guest@example.org", responseStatus: "accepted", displayName: "Guest", optional: true };
    const room = { email: "room@resource.calendar.google.com", resource: true, responseStatus: "accepted" };
    const requests: any[] = [];
    globalThis.fetch = (async (_url, init) => {
      if (init?.method !== "PATCH") return Response.json({ ...googleEvent(made.google_id), etag: "v1", attendees: [guest, room, { email: "remove@example.org" }] });
      requests.push({ body: JSON.parse(init.body as string), headers: init.headers });
      return Response.json(googleEvent(made.google_id));
    }) as typeof fetch;
    await runCalendarOutbound(actionCtx(f.t), f.accountId, "test", { op: "patch", google_id: made.google_id, calendar_google_id: "me@example.org", patch: { attendees: [guest.email, "new@example.org"] } });
    expect(requests[0].body.attendees).toEqual([guest, { email: "new@example.org" }, room]);
    expect(requests[0].headers["If-Match"]).toBe("v1");
    await runCalendarOutbound(actionCtx(f.t), f.accountId, "test", { op: "patch", google_id: made.google_id, calendar_google_id: "me@example.org", patch: { summary: "Only title" } });
    expect(requests[1].body).toEqual({ summary: "Only title" });
  });
  test("pump claims serialize accounts, recover stale work, and fence late completions", async () => {
    const f = await fixture("gmail");
    const made = await create(f);
    await dispatch(f, "updateEvent", { google_id: made.google_id, patch: { summary: "Later" } });
    const first = (await f.t.mutation(internal.gmail.pump.claimNext, { accountId: f.accountId }))!;
    expect(await f.t.mutation(internal.gmail.pump.claimNext, { accountId: f.accountId })).toBeNull();
    await f.t.run(ctx => ctx.db.patch(first._id, { updated_at: Date.now() - 12 * 60000 }));
    expect(await f.t.mutation(internal.gmail.pump.reapStaleInflight, { accountId: f.accountId })).toEqual({ requeued: 1 });
    const second = (await f.t.mutation(internal.gmail.pump.claimNext, { accountId: f.accountId }))!;
    expect(second._id).toBe(first._id);
    expect(second.attempts).toBe(2);
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: first._id, status: "done", attempt: 1 });
    expect((await f.t.run(ctx => ctx.db.get(first._id)))!.status).toBe("inflight");
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: second._id, status: "done", attempt: 2 });
    expect((await f.t.mutation(internal.gmail.pump.claimNext, { accountId: f.accountId }))!._id).not.toBe(first._id);
  });
  test("calendar backoff is enforced while mail proceeds; terminal errors can be retried", async () => {
    const f = await fixture("gmail");
    const made = await create(f);
    const first = (await f.t.mutation(internal.gmail.pump.claimNext, { accountId: f.accountId }))!;
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: first._id, status: "queued", attempt: 1, retry_at: Date.now() + 60000, error: "network" });
    await dispatch(f, "updateEvent", { google_id: made.google_id, patch: { summary: "Blocked behind insert" } });
    const mailId = await f.t.run(ctx => ctx.db.insert("outbound", { account_id: f.accountId, kind: "modify", payload: {}, status: "queued", attempts: 0, created_at: Date.now(), updated_at: Date.now() }));
    expect((await f.t.mutation(internal.gmail.pump.claimNext, { accountId: f.accountId }))!._id).toBe(mailId);
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: mailId, status: "done", attempt: 1 });
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: first._id, status: "error", error: "Calendar permission denied", surface_on_account: true });
    const account = (await f.t.run(ctx => ctx.db.get(f.accountId)))!;
    expect(account.sync_status).toBe("idle");
    expect(account.sync_error).toBeUndefined();
    expect(account.calendar_write_error).toBe("Calendar permission denied");
    expect(await f.t.mutation(internal.gmail.pump.claimNext, { accountId: f.accountId })).toBeNull();
    expect(await dispatch(f, "retryCalendarWrites")).toEqual({ retried: 1 });
    expect((await f.t.mutation(internal.gmail.pump.claimNext, { accountId: f.accountId }))!._id).toBe(first._id);
  });
  test("real pump action completes create-to-Google and clears pending status", async () => {
    const f = await fixture("gmail");
    const made = await create(f);
    globalThis.fetch = (async (_url, init) => Response.json(googleEvent(JSON.parse(init!.body as string).id))) as typeof fetch;
    expect((await f.t.action(internal.gmail.pump.pump, { accountId: f.accountId })).processed).toBe(1);
    expect((await event(f.t, made.event_id)).pending_outbound).toBeUndefined();
    expect((await queueRows(f.t))[0].status).toBe("done");
  });
});


describe("calendar synchronization", () => {
  test("paged full sync removes absent events, keeps pending writes and includes hidden readable calendars", async () => {
    const f = await fixture("gmail");
    const stale = await create(f);
    const pending = await create(f, { summary: "Pending local" });
    await f.t.run(async ctx => {
      await ctx.db.patch(stale.event_id, { pending_outbound: undefined, local_written_at: 0 });
      await ctx.db.patch(f.calendarId, { selected: false });
    });
    const requests: URL[] = [];
    globalThis.fetch = (async input => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname.endsWith("calendarList")) {
        expect(url.searchParams.get("showHidden")).toBe("true");
        return Response.json({ items: [{ id: "me@example.org", summary: "Work", accessRole: "owner", selected: false, hidden: true }] });
      }
      if (!url.searchParams.has("pageToken")) return Response.json({ items: [googleEvent("page-one")], nextPageToken: "two" });
      return Response.json({ items: [googleEvent("page-two")], nextSyncToken: "synced" });
    }) as typeof fetch;
    const result = await f.t.action(internal.calendar.sync.syncAccount, { accountId: f.accountId });
    expect(result.error).toBeUndefined();
    const all = await rows(f.t, "events");
    expect(all.filter(r => !r.deleted).map(r => r.google_id).sort()).toEqual([pending.google_id, "page-one", "page-two"].sort());
    expect((await event(f.t, stale.event_id)).deleted).toBe(true);
    const calendar = (await f.t.run(ctx => ctx.db.get(f.calendarId)))!;
    expect(calendar.selected).toBe(false);
    expect(calendar.sync_token).toBe("synced");
    expect(calendar.full_synced_at).toBeGreaterThan(0);
    expect(requests.filter(u => u.pathname.includes("/events"))).toHaveLength(2);
    const visible = await f.t.query(api.calendar.read.listEvents, { token: f.token });
    expect(visible.rows.some(r => r.google_id === "page-one")).toBe(true);
    // Readers see the mirrored window, never the sync cursor.
    const [listed] = await f.t.query(api.calendar.read.listCalendars, { token: f.token });
    expect(listed.window_start).toBe(calendar.window_start);
    expect(listed.window_end).toBe(calendar.window_end);
    expect("sync_token" in listed).toBe(false);
  });
  test("410 triggers complete reconciliation; daily refill brings newly in-range events", async () => {
    const f = await fixture("gmail");
    const old = await create(f);
    await f.t.run(async ctx => {
      await ctx.db.patch(old.event_id, { pending_outbound: undefined, local_written_at: 0 });
      await ctx.db.patch(f.calendarId, { sync_token: "expired", full_synced_at: Date.now(), window_start: Date.now() - WINDOW_PAST_MS, window_end: Date.now() + WINDOW_FUTURE_MS });
    });
    const requests: URL[] = [];
    globalThis.fetch = (async input => {
      const url = new URL(String(input)); requests.push(url);
      if (url.pathname.endsWith("calendarList")) return Response.json({ items: [{ id: "me@example.org", summary: "Work", accessRole: "owner", selected: true }] });
      if (url.searchParams.has("syncToken")) return new Response("gone", { status: 410 });
      return Response.json({ items: [googleEvent("newly-visible")], nextSyncToken: "fresh" });
    }) as typeof fetch;
    await f.t.action(internal.calendar.sync.syncAccount, { accountId: f.accountId });
    expect((await event(f.t, old.event_id)).deleted).toBe(true);
    expect(requests.some(u => u.searchParams.get("syncToken") === "expired")).toBe(true);
    expect(requests.some(u => u.searchParams.has("timeMin"))).toBe(true);
    await f.t.run(ctx => ctx.db.patch(f.calendarId, { full_synced_at: Date.now() - 86400001 }));
    requests.length = 0;
    await f.t.action(internal.calendar.sync.syncAccount, { accountId: f.accountId });
    expect(requests.some(u => u.searchParams.has("syncToken"))).toBe(false);
    expect(requests.some(u => u.searchParams.has("timeMax"))).toBe(true);
  });
  test("failed pagination cannot commit a cursor or tombstone unseen events", async () => {
    const f = await fixture("gmail");
    const old = await create(f);
    await f.t.run(ctx => ctx.db.patch(old.event_id, { pending_outbound: undefined, local_written_at: 0 }));
    globalThis.fetch = (async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("calendarList")) return Response.json({ items: [{ id: "me@example.org", accessRole: "owner", selected: true }] });
      if (url.searchParams.has("pageToken")) return new Response("failed", { status: 503 });
      return Response.json({ items: [googleEvent("page1")], nextPageToken: "broken" });
    }) as typeof fetch;
    const result = await f.t.action(internal.calendar.sync.syncAccount, { accountId: f.accountId });
    expect(result.error).toContain("503");
    expect((await event(f.t, old.event_id)).deleted).not.toBe(true);
    expect((await f.t.run(ctx => ctx.db.get(f.calendarId)))!.sync_token).toBeUndefined();
    const account = (await f.t.run(ctx => ctx.db.get(f.accountId)))!;
    expect(account.sync_status).toBe("idle");
    expect(account.calendar_error).toContain("503");
    expect(account.calendar_sync_run).toBeUndefined();
  });
  test("sync preserves local changes made after the request started and rejects stale runs", async () => {
    const f = await fixture("gmail");
    const made = await create(f);
    await f.t.run(ctx => ctx.db.patch(made.event_id, { pending_outbound: undefined, local_written_at: 0 }));
    const args = await syncArgs(f);
    expect(await f.t.mutation(internal.calendar.sync.claimSync, { accountId: f.accountId, run: "competing" })).toBeNull();
    await dispatch(f, "updateEvent", { google_id: made.google_id, patch: { summary: "Local wins" } });
    const current = await event(f.t, made.event_id);
    await f.t.run(ctx => ctx.db.patch(made.event_id, { pending_outbound: undefined, local_written_at: args.started + 1 }));
    const parsed = { calendar_google_id: "me@example.org", google_id: made.google_id, summary: "Old Google", start: current.start, end: current.end, all_day: false, status: "confirmed", attendees: [] };
    await f.t.mutation(internal.calendar.sync.applyEvents, { ...args, events: [parsed] });
    expect((await event(f.t, made.event_id)).summary).toBe("Local wins");
    expect(await f.t.mutation(internal.calendar.sync.applyEvents, { ...args, run: "stale", events: [parsed] })).toBe(false);
  });
  test("delta cancellations and moved-out events tombstone while overlapping boundaries survive", async () => {
    const f = await fixture("gmail");
    const args = await syncArgs(f);
    const parsed = { calendar_google_id: "me@example.org", google_id: "straddle", summary: "Long", start: args.windowStart - 86400000, end: args.windowStart + 86400000, all_day: false, status: "confirmed", attendees: [] };
    await f.t.mutation(internal.calendar.sync.applyEvents, { ...args, events: [parsed] });
    expect((await rows(f.t, "events"))[0].deleted).toBeUndefined();
    await f.t.mutation(internal.calendar.sync.applyEvents, { ...args, full: false, events: [{ ...parsed, end: args.windowStart }] });
    expect((await rows(f.t, "events"))[0].deleted).toBe(true);
    await f.t.mutation(internal.calendar.sync.applyEvents, { ...args, events: [parsed] });
    await f.t.mutation(internal.calendar.sync.applyEvents, { ...args, full: false, events: [{ ...parsed, status: "cancelled", start: 0, end: 0 }] });
    expect((await rows(f.t, "events"))[0].deleted).toBe(true);
  });
  test("disconnect during Google action cannot recreate orphaned rows", async () => {
    const f = await fixture("gmail");
    globalThis.fetch = (async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("calendarList")) return Response.json({ items: [{ id: "me@example.org", accessRole: "owner", selected: true }] });
      await f.t.run(async ctx => { await ctx.db.delete(f.calendarId); await ctx.db.delete(f.accountId); });
      return Response.json({ items: [googleEvent("orphan")], nextSyncToken: "next" });
    }) as typeof fetch;
    await f.t.action(internal.calendar.sync.syncAccount, { accountId: f.accountId });
    expect(await rows(f.t, "events")).toHaveLength(0);
    expect(await rows(f.t, "calendars")).toHaveLength(0);
  });
});


describe("calendar demos", () => {
  test("fresh seed creates Work and Personal with a current week of realistic events", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.mutation(api.demo.seed, {});
    const calendars = await t.query(api.calendar.read.listCalendars, { token: seeded.token });
    expect(calendars.map(c => c.summary).sort()).toEqual(["Personal", "Work"]);
    const data = await t.query(api.calendar.read.listEvents, { token: seeded.token });
    expect(data.rows.length).toBeGreaterThan(12);
    expect(data.rows.some(r => r.all_day && r.end - r.start === 86400000)).toBe(true);
    expect(data.rows.some(r => r.my_response === "declined")).toBe(true);
    expect(data.rows.some(r => r.start > Date.now())).toBe(true);
    expect(data.rows.every(r => !r.conference_url)).toBe(true);
  });
  test("ensure upgrades only authenticated demo accounts without overwriting changed events", async () => {
    const f = await fixture();
    const ensure = (api as any).calendar.demo.ensureDemoCalendars;
    await expect(f.t.mutation(ensure, {})).rejects.toThrow("Unauthorized");
    expect(await f.t.mutation(ensure, { token: f.token })).toEqual({ seeded: 1 });
    const first = (await rows(f.t, "events"))[0];
    await f.t.run(ctx => ctx.db.patch(first._id, { summary: "User edited", deleted: true }));
    expect(await f.t.mutation(ensure, { token: f.token })).toEqual({ seeded: 0 });
    expect(await event(f.t, first._id)).toMatchObject({ summary: "User edited", deleted: true });
    const gmail = await fixture("gmail");
    expect(await gmail.t.mutation(ensure, { token: gmail.token })).toEqual({ seeded: 0 });
    expect(await rows(gmail.t, "events")).toHaveLength(0);
  });
});


describe("calendar final regressions", () => {
  test("Convex Auth callers see only their own calendars without a legacy token", async () => {
    const f = await fixture();
    const other = await fixture("demo", f.t);
    await create(f);
    const caller = f.t.withIdentity({ subject: `${other.userId}|session` });
    expect((await caller.query(api.calendar.read.listEvents, {})).rows).toHaveLength(0);
    expect((await caller.query(api.calendar.read.listCalendars, {})).map(c => c.account_id)).toEqual([other.accountId]);
  });
  test("a calendar write stops after five failures and exposes a retryable error", async () => {
    const f = await fixture("gmail");
    const made = await create(f);
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("unavailable", { status: 503 }); }) as typeof fetch;
    for (let i = 0; i < 5; i++) {
      await f.t.action(internal.gmail.pump.pump, { accountId: f.accountId });
      const row = (await queueRows(f.t))[0];
      await f.t.run(ctx => ctx.db.patch(row._id, { retry_at: 0 }));
    }
    expect(calls).toBe(5);
    const outbound = (await queueRows(f.t))[0];
    expect(outbound).toMatchObject({ status: "error", attempts: 5 });
    expect((await event(f.t, made.event_id)).pending_outbound).toBeUndefined();
    const publicState = await f.t.query(api.sync.getAccount, { token: f.token });
    expect(publicState.account.calendar_error).toContain("503");
    expect(publicState.account.sync_status).toBe("idle");
    await f.t.action(internal.gmail.pump.pump, { accountId: f.accountId });
    expect(calls).toBe(5);
  });
  test("hundreds of delayed calendar rows cannot hide queued mail", async () => {
    const f = await fixture("gmail");
    const mailId = await f.t.run(async ctx => {
      for (let i = 0; i < 505; i++) await ctx.db.insert("outbound", {
        account_id: f.accountId, kind: "calendar", payload: { calendar_google_id: "me@example.org", google_id: `waiting-${i}` },
        status: "queued", attempts: 1, retry_at: Date.now() + 60000, created_at: i, updated_at: Date.now(),
      });
      return await ctx.db.insert("outbound", { account_id: f.accountId, kind: "modify", payload: {}, status: "queued", attempts: 0, created_at: Date.now(), updated_at: Date.now() });
    });
    expect((await f.t.mutation(internal.gmail.pump.claimNext, { accountId: f.accountId }))!._id).toBe(mailId);
  });
  test("reconciliation drains every database page before committing the full cursor", async () => {
    const f = await fixture("gmail");
    await f.t.run(async ctx => {
      for (let i = 0; i < 225; i++) await ctx.db.insert("events", {
        account_id: f.accountId, calendar_google_id: "me@example.org", google_id: `stale-${i}`, summary: "Stale",
        start: Date.now(), end: Date.now() + 1000, all_day: false, status: "confirmed", attendees: [], updated_at: 1,
      });
    });
    globalThis.fetch = (async input => String(input).includes("calendarList")
      ? Response.json({ items: [{ id: "me@example.org", accessRole: "owner" }] })
      : Response.json({ items: [], nextSyncToken: "empty-full" })) as typeof fetch;
    await f.t.action(internal.calendar.sync.syncAccount, { accountId: f.accountId });
    expect((await rows(f.t, "events")).filter(r => r.deleted)).toHaveLength(225);
    expect((await f.t.run(ctx => ctx.db.get(f.calendarId)))!.sync_token).toBe("empty-full");
  });
});

describe("calendar review regressions", () => {
  test("create retries compare the original normalized input despite later edits", async () => {
    const f = await fixture();
    const input = { client_id: "uncertain", summary: "  Original  ", start: 1800000000000, end: 1800003600000, description: "  Notes  ", location: "  Room  ", attendees: [" A@Example.org ", "a@example.org", "b@example.org"] };
    const made = await create(f, input);
    const normalized = { ...input, summary: "Original", description: "Notes", location: "Room", attendees: ["b@example.org", "a@example.org"] };
    expect((await create(f, normalized)).event_id).toBe(made.event_id);
    for (const change of [{ summary: "Edited after timeout" }, { start: input.start + 1000 }, { location: "Elsewhere" }, { attendees: [] }]) {
      await expect(create(f, { ...normalized, ...change })).rejects.toThrow("Open the existing event to apply your changes");
    }
    await dispatch(f, "updateEvent", { google_id: made.google_id, patch: { summary: "Edited existing event" } });
    expect((await create(f, normalized)).event_id).toBe(made.event_id);
    await expect(create(f, { ...normalized, summary: "Edited existing event" })).rejects.toThrow("already created");
    expect((await event(f.t, made.event_id)).summary).toBe("Edited existing event");
    expect(await queueRows(f.t)).toHaveLength(2);
    await f.t.run(ctx => ctx.db.patch(made.event_id, { create_fingerprint: undefined }));
    await expect(create(f, normalized)).rejects.toThrow("unverified details");
  });

  test("insert retries send the original queued payload after local edits", async () => {
    const f = await fixture("gmail");
    const made = await create(f, { summary: "Original" });
    const payload = (await queueRows(f.t))[0].payload as CalendarOp;
    await dispatch(f, "updateEvent", { google_id: made.google_id, patch: { summary: "New title" } });
    const titles: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      titles.push(JSON.parse(init!.body as string).summary);
      if (titles.length === 1) throw new Error("lost acknowledgement");
      return Response.json(googleEvent(made.google_id));
    }) as typeof fetch;
    await expect(runCalendarOutbound(actionCtx(f.t), f.accountId, "token", payload)).rejects.toThrow("lost acknowledgement");
    await runCalendarOutbound(actionCtx(f.t), f.accountId, "token", payload);
    expect(titles).toEqual(["Original", "Original"]);
    expect((await event(f.t, made.event_id)).summary).toBe("New title");
  });

  test("editing location and notes recomputes extracted Join links, including removals", async () => {
    const f = await fixture();
    const made = await create(f, { location: "https://zoom.us/j/111" });
    const edit = async (patch: Record<string, unknown>) => {
      await dispatch(f, "updateEvent", { google_id: made.google_id, patch });
      return (await event(f.t, made.event_id)).conference_url;
    };
    expect(await edit({ location: "https://zoom.us/j/222" })).toBe("https://zoom.us/j/222");
    expect(await edit({ location: "Room 4" })).toBeUndefined();
    expect(await edit({ description: "Join https://meet.google.com/aaa-bbbb-ccc" })).toBe("https://meet.google.com/aaa-bbbb-ccc");
    expect(await edit({ description: "Join https://zoom.us/j/333" })).toBe("https://zoom.us/j/333");
    expect(await edit({ description: "" })).toBeUndefined();
    expect(await edit({ location: "https://zoom.us/j/444", description: "https://zoom.us/j/555" })).toBe("https://zoom.us/j/444");
    expect(await edit({ location: "" })).toBe("https://zoom.us/j/555");
    expect(await edit({ description: "" })).toBeUndefined();
  });

  test("provider-native conference URLs stay authoritative even when identical to removed text", async () => {
    const f = await fixture();
    const made = await create(f);
    for (const native of [{ hangoutLink: "https://meet.google.com/aaa-bbbb-ccc" }, { conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/123" }] } }]) {
      const parsed = parseGoogleEvent({ ...googleEvent(made.google_id), ...native }, "me@example.org")!;
      await f.t.run(ctx => ctx.db.patch(made.event_id, { ...parsed, location: parsed.conference_url }));
      await dispatch(f, "updateEvent", { google_id: made.google_id, patch: { location: "", description: "https://zoom.us/j/other" } });
      expect((await event(f.t, made.event_id)).conference_url).toBe(parsed.native_conference_url);
    }
  });

  async function invitation() {
    const f = await fixture("gmail");
    const remote = { ...googleEvent("invitation"), organizer: { email: "host@example.org" }, attendees: [{ email: "me@example.org", self: true, responseStatus: "needsAction" }] };
    const args = await syncArgs(f);
    await f.t.mutation(internal.calendar.sync.applyEvents, { ...args, events: [parseGoogleEvent(remote, "me@example.org")!] });
    const id = (await rows(f.t, "events"))[0]._id;
    return { ...f, remote, id, args };
  }
  async function catchUp(f: Awaited<ReturnType<typeof invitation>>) {
    const local = await event(f.t, f.id);
    expect(local.reconcile_after).toBeDefined();
    await f.t.action(internal.calendar.sync.reconcileEvent, { eventId: f.id, after: local.reconcile_after! });
  }

  test.each(["queued", "inflight"])("organizer reschedules during %s RSVP; catch-up follows write completion", async status => {
    const f = await invitation();
    await dispatch(f, "rsvpEvent", { google_id: "invitation", response: "accepted" });
    const before = await event(f.t, f.id);
    if (status === "inflight") await f.t.mutation(internal.gmail.pump.claimNext, { accountId: f.accountId });
    const moved = { ...f.remote, start: { dateTime: new Date(before.start + 86400000).toISOString() }, end: { dateTime: new Date(before.end + 86400000).toISOString() } };
    await f.t.mutation(internal.calendar.sync.applyEvents, { ...f.args, full: false, events: [parseGoogleEvent(moved, "me@example.org")!] });
    await f.t.mutation(internal.calendar.sync.setSyncToken, { calendarId: f.calendarId, run: f.args.run, sync_token: "consumed-move", full: false, windowStart: f.args.windowStart, windowEnd: f.args.windowEnd, started: f.args.started });
    expect((await event(f.t, f.id)).start).toBe(before.start);
    expect((await event(f.t, f.id)).reconcile_after).toBe(before.reconcile_after);
    let reads = 0;
    globalThis.fetch = (async () => { reads++; return Response.json({ ...moved, attendees: [{ ...moved.attendees[0], responseStatus: "accepted" }] }); }) as typeof fetch;
    await catchUp(f);
    expect(reads).toBe(0);
    const pending = (await queueRows(f.t))[0];
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: pending._id, status: "done" });
    await catchUp(f);
    expect(reads).toBe(1);
    expect(await event(f.t, f.id)).toMatchObject({ start: before.start + 86400000, my_response: "accepted" });
    expect((await event(f.t, f.id)).reconcile_after).toBeUndefined();
    expect((await f.t.run(ctx => ctx.db.get(f.calendarId)))!.sync_token).toBe("consumed-move");
  });

  test("terminal RSVP failures still catch up and preserve the retryable error", async () => {
    const f = await invitation();
    await dispatch(f, "rsvpEvent", { google_id: "invitation", response: "accepted" });
    const before = await event(f.t, f.id);
    const moved = { ...f.remote, start: { dateTime: new Date(before.start + 3600000).toISOString() }, end: { dateTime: new Date(before.end + 3600000).toISOString() } };
    await f.t.mutation(internal.calendar.sync.applyEvents, { ...f.args, events: [parseGoogleEvent(moved, "me@example.org")!] });
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: before.pending_outbound!, status: "error", error: "RSVP denied" });
    globalThis.fetch = (async () => Response.json(moved)) as typeof fetch;
    await catchUp(f);
    expect(await event(f.t, f.id)).toMatchObject({ start: before.start + 3600000, my_response: "needsAction", write_error: "RSVP denied" });
    await dispatch(f, "retryCalendarWrites");
    expect((await event(f.t, f.id)).reconcile_after).toBeDefined();
    expect((await queueRows(f.t))[0].payload.response).toBe("accepted");
  });

  test("catch-up proceeds when a second RSVP is blocked behind a terminal failure", async () => {
    const f = await invitation();
    await dispatch(f, "rsvpEvent", { google_id: "invitation", response: "accepted" });
    const first = (await event(f.t, f.id)).pending_outbound!;
    await dispatch(f, "rsvpEvent", { google_id: "invitation", response: "tentative" });
    const before = await event(f.t, f.id);
    const second = before.pending_outbound!;
    expect(second).not.toBe(first);
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: first, status: "error", error: "RSVP denied" });
    expect(await f.t.mutation(internal.gmail.pump.claimNext, { accountId: f.accountId })).toBeNull();
    const moved = { ...f.remote, start: { dateTime: new Date(before.start + 3600000).toISOString() }, end: { dateTime: new Date(before.end + 3600000).toISOString() } };
    globalThis.fetch = (async () => Response.json(moved)) as typeof fetch;
    await catchUp(f);
    expect(await event(f.t, f.id)).toMatchObject({ start: before.start + 3600000, write_error: "RSVP denied", pending_outbound: second });
    expect((await event(f.t, f.id)).reconcile_after).toBeUndefined();
    expect((await queueRows(f.t)).map(row => [row.status, row.payload.response])).toEqual([["error", "accepted"], ["queued", "tentative"]]);
    await dispatch(f, "retryCalendarWrites");
    expect((await f.t.mutation(internal.gmail.pump.claimNext, { accountId: f.accountId }))?._id).toBe(first);
    expect((await event(f.t, f.id)).reconcile_after).toBeDefined();
  });

  test("a newer RSVP queued during the catch-up read fences the old result", async () => {
    const f = await invitation();
    await dispatch(f, "rsvpEvent", { google_id: "invitation", response: "accepted" });
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: (await event(f.t, f.id)).pending_outbound!, status: "done" });
    let reads = 0;
    globalThis.fetch = (async () => {
      if (++reads === 1) await dispatch(f, "rsvpEvent", { google_id: "invitation", response: "declined" });
      return Response.json({ ...f.remote, attendees: [{ ...f.remote.attendees[0], responseStatus: reads === 1 ? "accepted" : "declined" }] });
    }) as typeof fetch;
    await catchUp(f);
    expect((await event(f.t, f.id)).my_response).toBe("declined");
    await catchUp(f);
    expect(reads).toBe(1);
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: (await event(f.t, f.id)).pending_outbound!, status: "done" });
    await catchUp(f);
    expect(reads).toBe(2);
    expect((await event(f.t, f.id)).reconcile_after).toBeUndefined();
  });

  test("a skipped revision after completion catches up once protection expires", async () => {
    const f = await invitation();
    await f.t.run(ctx => ctx.db.patch(f.id, { local_written_at: f.args.started + 1 }));
    await f.t.mutation(internal.calendar.sync.applyEvents, { ...f.args, events: [parseGoogleEvent({ ...f.remote, summary: "Organizer changed title" }, "me@example.org")!] });
    const local = await event(f.t, f.id);
    expect(local.summary).not.toBe("Organizer changed title");
    globalThis.fetch = (async () => Response.json({ ...f.remote, summary: "Organizer changed title" })) as typeof fetch;
    await catchUp(f);
    expect((await event(f.t, f.id)).summary).toBe("Organizer changed title");
    let reads = 0;
    globalThis.fetch = (async () => { reads++; return Response.json(f.remote); }) as typeof fetch;
    await f.t.action(internal.calendar.sync.reconcileEvent, { eventId: f.id, after: local.reconcile_after! });
    expect(reads).toBe(0);
  });

  test("catch-up failures back off, keep one current job, and recover without a full sync", async () => {
    const f = await invitation();
    await dispatch(f, "rsvpEvent", { google_id: "invitation", response: "accepted" });
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: (await event(f.t, f.id)).pending_outbound!, status: "done" });
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("temporary", { status: 503 }); }) as typeof fetch;
    for (let failures = 0; failures < 6; failures++) {
      const local = await event(f.t, f.id);
      const before = Date.now();
      await f.t.action(internal.calendar.sync.reconcileEvent, { eventId: f.id, after: local.reconcile_after!, failures });
      const next = await event(f.t, f.id);
      expect(next.reconcile_after! - before).toBeGreaterThanOrEqual(Math.min(30000 * 2 ** (failures + 1), 300000));
      expect(next.reconcile_after! - Date.now()).toBeLessThanOrEqual(300010);
      await f.t.action(internal.calendar.sync.reconcileEvent, { eventId: f.id, after: local.reconcile_after!, failures });
      expect(calls).toBe(failures + 1);
    }
    globalThis.fetch = (async () => Response.json({ ...f.remote, summary: "Recovered" })) as typeof fetch;
    await catchUp(f);
    expect((await event(f.t, f.id)).summary).toBe("Recovered");
    expect((await f.t.run(ctx => ctx.db.get(f.accountId)))!.calendar_error).toBeUndefined();
    expect((await event(f.t, f.id)).reconcile_after).toBeUndefined();
  });

  test("catch-up installs a durable watchdog before provider IO", async () => {
    const f = await invitation();
    await dispatch(f, "rsvpEvent", { google_id: "invitation", response: "accepted" });
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: (await event(f.t, f.id)).pending_outbound!, status: "done" });
    const local = await event(f.t, f.id);
    const scheduledBefore = await f.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
    expect(await f.t.mutation(internal.calendar.sync.prepareReconcile, { eventId: f.id, after: local.reconcile_after! })).not.toBeNull();
    const scheduledAfter = await f.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduledAfter).toHaveLength(scheduledBefore.length + 1);
    const watchdog = scheduledAfter.find(row => !scheduledBefore.some(old => old._id === row._id))!;
    expect(watchdog.args).toEqual([{ eventId: f.id, after: local.reconcile_after }]);
    expect(watchdog.scheduledTime - Date.now()).toBeGreaterThan(590000);
    globalThis.fetch = (async () => Response.json({ ...f.remote, summary: "Watchdog recovered lost action" })) as typeof fetch;
    await catchUp(f);
    expect((await event(f.t, f.id)).summary).toBe("Watchdog recovered lost action");
  });

  test("provider removal clears native and extracted links across mutation serialization", async () => {
    const f = await invitation();
    const withLink = { ...f.remote, hangoutLink: "https://meet.google.com/aaa-bbbb-ccc", location: "https://zoom.us/j/123" };
    await f.t.mutation(internal.calendar.sync.applyEvents, { ...f.args, events: [parseGoogleEvent(withLink, "me@example.org")!] });
    expect((await event(f.t, f.id)).native_conference_url).toBe(withLink.hangoutLink);
    await f.t.mutation(internal.calendar.sync.applyEvents, { ...f.args, events: [parseGoogleEvent(f.remote, "me@example.org")!] });
    expect((await event(f.t, f.id)).native_conference_url).toBeUndefined();
    expect((await event(f.t, f.id)).conference_url).toBeUndefined();
    expect((await event(f.t, f.id)).location).toBeUndefined();
    await f.t.run(ctx => ctx.db.patch(f.id, { native_conference_url: withLink.hangoutLink, conference_url: withLink.hangoutLink }));
    await dispatch(f, "rsvpEvent", { google_id: "invitation", response: "accepted" });
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: (await event(f.t, f.id)).pending_outbound!, status: "done" });
    globalThis.fetch = (async () => Response.json(f.remote)) as typeof fetch;
    await catchUp(f);
    expect((await event(f.t, f.id)).native_conference_url).toBeUndefined();
    expect((await event(f.t, f.id)).conference_url).toBeUndefined();
  });

  test("catch-up handles cancellation and does not discard a failed unsent create", async () => {
    const f = await invitation();
    await dispatch(f, "rsvpEvent", { google_id: "invitation", response: "accepted" });
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: (await event(f.t, f.id)).pending_outbound!, status: "done" });
    globalThis.fetch = (async () => new Response("gone", { status: 410 })) as typeof fetch;
    await catchUp(f);
    expect((await event(f.t, f.id)).deleted).toBe(true);
    const made = await create(f, { summary: "Unsent draft" });
    const draft = await event(f.t, made.event_id);
    await f.t.mutation(internal.gmail.pump.finish, { outboundId: draft.pending_outbound!, status: "error", error: "Insert denied" });
    globalThis.fetch = (async () => new Response("missing", { status: 404 })) as typeof fetch;
    await f.t.action(internal.calendar.sync.reconcileEvent, { eventId: made.event_id, after: draft.reconcile_after! });
    expect((await event(f.t, made.event_id)).deleted).toBeUndefined();
    expect((await event(f.t, made.event_id)).write_error).toBe("Insert denied");
  });

});
