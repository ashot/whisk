import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Calendar } from "@mail/shared/src/lib/calendarTypes";
import { pickCalendar, eventInput } from "./calendar";
const calendar: Calendar = {
  _id: "c",
  account_id: "a",
  google_id: "work",
  summary: "Work",
  access_role: "owner",
  primary: true,
  updated_at: 1,
};
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  process.env.TZ = zone;
});
test("calendar writes choose primary but never guess through ambiguity", () => {
  expect(pickCalendar([calendar], "a")).toBe(calendar);
  expect(() =>
    pickCalendar([{ ...calendar, access_role: "reader" }], "a"),
  ).toThrow("No writable");
  expect(() => pickCalendar([calendar], "b")).toThrow();
  expect(() =>
    pickCalendar([calendar, { ...calendar, _id: "other" }], "a", "Work"),
  ).toThrow("Choose");
  expect(pickCalendar([calendar], "a", "work")).toBe(calendar);
});
test("timed defaults and explicit ISO offsets", () => {
  const input = eventInput(" Review ", calendar, {
    start: "2026-09-05T09:00",
    guests: "ada@example.com, ADA@example.com",
  });
  expect(input.summary).toBe("Review");
  expect(input.end - input.start).toBe(30 * 60_000);
  expect(input.attendees).toEqual(["ada@example.com"]);
  expect(
    eventInput("Review", calendar, {
      start: "2026-09-05T09:00-04:00",
      duration: "2h",
    }).start,
  ).toBe(input.start);
});
test("all-day dates use UTC boundaries and exclusive end across DST", () => {
  const input = eventInput("Away", calendar, {
    start: "2026-03-08",
    end: "2026-03-10",
    allDay: true,
  });
  expect(input.start).toBe(Date.UTC(2026, 2, 8));
  expect(input.end).toBe(Date.UTC(2026, 2, 10));
  expect(
    eventInput("Away", calendar, { start: "2026-03-08", allDay: true }).end,
  ).toBe(Date.UTC(2026, 2, 9));
});
test("invalid dates, missing hours, invalid guests and conflicting flags fail before writes", () => {
  for (const start of [
    "2026-02-30",
    "2026-03-08T02:30",
    "2026-09-05T25:00Z",
    "garbage",
    "2026-09-05T00:99Z",
  ])
    expect(() => eventInput("Review", calendar, { start })).toThrow();
  for (const options of [
    { duration: "0m" },
    { duration: "1.5h" },
    { end: "2026-09-04" },
    { guests: "not-an-email" },
    { allDay: true, duration: "2h" },
    { duration: "2h", end: "2026-09-06" },
  ])
    expect(() =>
      eventInput("Review", calendar, { start: "2026-09-05", ...options }),
    ).toThrow();
  expect(() => eventInput(" ", calendar, { start: "tomorrow" })).toThrow();
});

test("natural-language calendar dates reject nonexistent wall times", () => {
  const now = new Date("2026-03-07T12:00:00-05:00").getTime();
  for (const start of [
    "tomorrow 2:30am",
    "sun 2:30am",
    "2:30am",
    "on 2026-03-08T02:30",
    "at 2026-03-08T02:30",
    "on on 2026-03-08T02:30",
    "on 2026-02-30",
  ])
    expect(() => eventInput("DST", calendar, { start }, now)).toThrow(
      "Use valid dates",
    );
  expect(() =>
    eventInput(
      "DST",
      calendar,
      { start: "tomorrow 1am", end: "tomorrow 2:30am" },
      now,
    ),
  ).toThrow("Use valid dates");
  expect(
    eventInput("DST", calendar, { start: "tomorrow 3:30am" }, now).start,
  ).toBe(Date.parse("2026-03-08T03:30:00-04:00"));
  expect(eventInput("DST", calendar, { start: "24h" }, now).start).toBe(
    now + 86400000,
  );
});
