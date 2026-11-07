import { afterEach, describe, expect, test } from "bun:test";
import { conferenceUrl, dateToUtcMidnight, listCalendars, listEvents, parseGoogleEvent, toGoogleEventBody, parseCalendarListEntry, safeUrl } from "./api";
import { validateEvent } from "./write";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const raw = { id: "event", start: { dateTime: "2026-03-08T01:30:00-05:00" }, end: { dateTime: "2026-03-08T03:30:00-04:00" } };

describe("calendar parsing and validation", () => {
  test("timed events retain offsets across DST", () => {
    const event = parseGoogleEvent(raw, "primary")!;
    expect(event.end - event.start).toBe(3600000);
    expect(event.all_day).toBe(false);
  });
  test("all-day dates use strict UTC dates and exclusive ends", () => {
    const event = parseGoogleEvent({ id: "a", start: { date: "2026-03-08" }, end: { date: "2026-03-10" } }, "c")!;
    expect(event.end - event.start).toBe(2 * 86400000);
    expect(toGoogleEventBody(event)).toMatchObject({ start: { date: "2026-03-08" }, end: { date: "2026-03-10" } });
    expect(Number.isNaN(dateToUtcMidnight("2026-02-30"))).toBe(true);
    expect(Number.isNaN(dateToUtcMidnight("2026-2-3"))).toBe(true);
    expect(parseGoogleEvent({ id: "a", start: { date: "2026-02-30" }, end: { date: "2026-03-03" } }, "c")).toBeNull();
  });
  test("malformed live spans fail while untimed cancellations remain tombstones", () => {
    expect(parseGoogleEvent({ id: "x", status: "cancelled" }, "c")).toMatchObject({ start: 0, end: 0, status: "cancelled" });
    expect(parseGoogleEvent({ ...raw, end: raw.start }, "c")).toBeNull();
    expect(parseGoogleEvent({ ...raw, end: undefined }, "c")).toBeNull();
    expect(parseGoogleEvent({ id: "x", start: { date: "2026-09-04" } }, "c")).toBeNull();
  });
  test("conference links must be safe and actually present", () => {
    expect(conferenceUrl({ ...raw, hangoutLink: "javascript:alert(1)" })).toBeUndefined();
    expect(conferenceUrl({ ...raw, conferenceData: { entryPoints: [{ entryPointType: "video", uri: "data:text/html,x" }] } })).toBeUndefined();
    expect(conferenceUrl({ ...raw, location: "https://zoom.us/j/123456" })).toBe("https://zoom.us/j/123456");
    expect(conferenceUrl({ ...raw, description: "Meet tomorrow" })).toBeUndefined();
    expect(safeUrl("https://secret@example.org/")).toBeUndefined();
    expect(parseGoogleEvent({ ...raw, htmlLink: "javascript:x" }, "c")!.html_link).toBeUndefined();
  });
  test("recurrence and self RSVP are represented", () => {
    const event = parseGoogleEvent({ ...raw, recurringEventId: "series", attendees: [{ email: "a@b.co", self: true, responseStatus: "declined" }] }, "c")!;
    expect(event.recurring_event_id).toBe("series");
    expect(event.my_response).toBe("declined");
    expect(parseGoogleEvent({ ...raw, recurrence: ["RRULE:FREQ=WEEKLY"] }, "c")!.recurring).toBe(true);
  });
  test("Google visibility is a hint with a primary default", () => {
    expect(parseCalendarListEntry({ id: "a", primary: true }).selected).toBe(true);
    expect(parseCalendarListEntry({ id: "a", selected: true, hidden: true }).selected).toBe(false);
  });
  test("writes reject invalid times, oversized fields, and guests", () => {
    const input = { summary: "Review", start: 1000000, end: 2000000, all_day: false };
    for (const patch of [
      { start: NaN }, { end: Infinity }, { end: input.start }, { start: -1 }, { start: 3e6 },
      { all_day: true }, { all_day: "yes" }, { summary: " " }, { summary: "a".repeat(501) },
      { description: "x".repeat(20001) }, { location: "x".repeat(1001) },
      { attendees: ["not-an-email"] }, { attendees: ["a@example.org\nBcc:b@example.org"] },
      { attendees: Array(101).fill("a@b.co") },
    ]) expect(() => validateEvent({ ...input, ...patch })).toThrow();
    expect(validateEvent({ ...input, attendees: [" A@Example.org ", "a@example.org"] }).attendees).toEqual(["a@example.org"]);
  });
  test("incremental requests retain expansion and deleted flags without time bounds", async () => {
    const urls: URL[] = [];
    globalThis.fetch = (async (input) => { urls.push(new URL(String(input))); return Response.json({ items: [], nextSyncToken: "next" }); }) as typeof fetch;
    await listEvents("token", "a@example.org", { timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-02-01T00:00:00Z" });
    await listEvents("token", "a@example.org", { syncToken: "sync", pageToken: "page", timeMin: "ignored" });
    for (const url of urls) {
      expect(url.searchParams.get("singleEvents")).toBe("true");
      expect(url.searchParams.get("showDeleted")).toBe("true");
    }
    expect(urls[1].searchParams.get("timeMin")).toBeNull();
    expect(urls[1].searchParams.get("timeMax")).toBeNull();
    expect(urls[1].searchParams.get("syncToken")).toBe("sync");
    expect(urls[1].searchParams.get("pageToken")).toBe("page");
  });
});


test("every calendar list page requests hidden calendars", async () => {
  const urls: URL[] = [];
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.searchParams.get("showHidden") !== "true") return Response.json({ items: [] });
    return Response.json(url.searchParams.has("pageToken")
      ? { items: [{ id: "hidden", hidden: true }] }
      : { items: [{ id: "primary" }], nextPageToken: "second" });
  }) as typeof fetch;
  expect((await listCalendars("token")).map(c => c.id)).toEqual(["primary", "hidden"]);
  expect(urls).toHaveLength(2);
  expect(urls.map(url => url.searchParams.get("showHidden"))).toEqual(["true", "true"]);
  expect(urls[1].searchParams.get("pageToken")).toBe("second");
});
