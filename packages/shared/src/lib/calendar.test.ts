import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  addCalendarDays,
  calendarGuests,
  calendarKey,
  calendarPreferences,
  calendarVisible,
  defaultEventTime,
  editableEvent,
  eventOnDay,
  eventsForDay,
  freeSlots,
  localDateTime,
  localDayKey,
  localDayStart,
  safeCalendarUrl,
  utcDayStamp,
} from "./calendar";
import type { Calendar, CalendarEvent } from "./calendarTypes";

const oldZone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  process.env.TZ = oldZone;
});
const calendar: Calendar = {
  _id: "c",
  account_id: "a",
  google_id: "work",
  summary: "Work",
  access_role: "owner",
  updated_at: 1,
};
const event = (
  start: number,
  end: number,
  extra: Partial<CalendarEvent> = {},
): CalendarEvent => ({
  _id: "e",
  account_id: "a",
  calendar_google_id: "work",
  google_id: "e",
  summary: "Review",
  start,
  end,
  all_day: false,
  status: "confirmed",
  attendees: [],
  updated_at: 1,
  ...extra,
});
const at = (time: string, day = "2026-09-04") => localDateTime(day, time);

describe("calendar date boundaries", () => {
  test("moves by local dates across 23- and 25-hour days", () => {
    expect(addCalendarDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(localDayStart("2026-03-09") - localDayStart("2026-03-08")).toBe(
      23 * 3600000,
    );
    expect(localDayStart("2026-11-02") - localDayStart("2026-11-01")).toBe(
      25 * 3600000,
    );
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  test("rejects nonexistent dates and spring-forward wall times", () => {
    expect(Number.isNaN(utcDayStamp("2026-02-30"))).toBe(true);
    expect(Number.isNaN(localDateTime("2026-03-08", "02:30"))).toBe(true);
    expect(Number.isNaN(localDateTime("2026-09-04", "24:00"))).toBe(true);
    expect(localDayKey(localDateTime("2026-11-01", "01:30"))).toBe(
      "2026-11-01",
    );
  });
  test("all-day events keep their calendar date west of UTC and exclusive end", () => {
    const row = event(utcDayStamp("2026-09-04"), utcDayStamp("2026-09-06"), {
      all_day: true,
    });
    expect(eventOnDay(row, "2026-09-03")).toBe(false);
    expect(eventOnDay(row, "2026-09-04")).toBe(true);
    expect(eventOnDay(row, "2026-09-05")).toBe(true);
    expect(eventOnDay(row, "2026-09-06")).toBe(false);
  });
  test("overnight events occur on both days but midnight ends only once", () => {
    const row = event(at("23:30"), at("00:30", "2026-09-05"));
    expect(eventOnDay(row, "2026-09-04")).toBe(true);
    expect(eventOnDay(row, "2026-09-05")).toBe(true);
    expect(
      eventOnDay({ ...row, end: localDayStart("2026-09-05") }, "2026-09-05"),
    ).toBe(false);
  });
});

describe("calendar feed and creation", () => {
  test("merges accounts chronologically with all-day entries first", () => {
    const rows = [
      event(at("14:00"), at("15:00")),
      event(at("09:00"), at("10:00"), { _id: "other", account_id: "b" }),
      event(utcDayStamp("2026-09-04"), utcDayStamp("2026-09-05"), {
        _id: "day",
        all_day: true,
      }),
    ];
    expect(eventsForDay(rows, "2026-09-04").map((row) => row._id)).toEqual([
      "day",
      "other",
      "e",
    ]);
  });
  test("overlaps merge into busy time, declined and cancelled events do not", () => {
    const rows = [
      event(at("10:00"), at("12:00")),
      event(at("11:00"), at("13:00")),
      event(at("15:00"), at("17:00"), { my_response: "declined" }),
      event(at("09:00"), at("10:00"), { status: "cancelled" }),
    ];
    expect(freeSlots(rows, "2026-09-04", at("08:00"))).toEqual([
      { start: at("09:00"), end: at("10:00") },
      { start: at("13:00"), end: at("18:00") },
    ]);
  });
  test("today creation starts ahead of now and never crosses the chosen gap", () => {
    const rows = [event(at("10:15"), at("12:00"))];
    expect(defaultEventTime("2026-09-04", rows, at("09:47"))).toEqual({
      start: at("10:00"),
      end: at("10:15"),
    });
    expect(defaultEventTime("2026-09-04", [], at("23:45")).start).toBe(
      localDayStart("2026-09-05"),
    );
  });
  test("calendar identities remain account-specific and explicit visibility overrides Google", () => {
    expect(calendarKey("a", "work")).not.toBe(calendarKey("b", "work"));
    expect(calendarVisible({ ...calendar, selected: false }, {})).toBe(false);
    expect(
      calendarVisible(
        { ...calendar, selected: false },
        { hiddenCalendars: [] },
      ),
    ).toBe(true);
    expect(calendarVisible(calendar, { hiddenCalendars: ["a:work"] })).toBe(
      false,
    );
    expect(
      calendarPreferences({ hiddenCalendars: [4, "a:work"] }).hiddenCalendars,
    ).toEqual(["a:work"]);
  });
  test("editing requires organizer ownership, writer access and no recurrence", () => {
    const own = event(at("10:00"), at("11:00"), {
      organizer: { email: "me", self: true },
    });
    expect(editableEvent(own, calendar)).toBe(true);
    expect(editableEvent({ ...own, recurring: true }, calendar)).toBe(false);
    expect(editableEvent(own, { ...calendar, access_role: "reader" })).toBe(
      false,
    );
    expect(
      editableEvent({ ...own, organizer: { email: "other" } }, calendar),
    ).toBe(false);
  });
  test("guest parsing and links reject unsafe or ambiguous input", () => {
    expect(
      calendarGuests("Ada@example.com; ada@example.com\nben@example.com"),
    ).toEqual(["ada@example.com", "ben@example.com"]);
    expect(calendarGuests("not an address")).toBe(null);
    expect(safeCalendarUrl("javascript:alert(1)")).toBe(null);
    expect(safeCalendarUrl("https://user:pass@example.com")).toBe(null);
    expect(safeCalendarUrl("https://meet.google.com/abc-defg-hij")).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
  });
});
