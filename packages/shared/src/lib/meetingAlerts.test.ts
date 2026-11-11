import { describe, expect, test } from "bun:test";
import type { Calendar, CalendarEvent } from "./calendarTypes";
import {
  meetingContent,
  meetingKey,
  meetingPreferences,
  meetingStage,
  shouldAlertMeeting,
  upcomingMeetings,
} from "./meetingAlerts";
import { normalizePrefs } from "./notifications";
const now = new Date(2026, 8, 4, 12).getTime();
const cal: Calendar = {
  _id: "c",
  account_id: "a",
  google_id: "work",
  summary: "Work",
  access_role: "owner",
  updated_at: 1,
};
const event: CalendarEvent = {
  _id: "e",
  account_id: "a",
  calendar_google_id: "work",
  google_id: "google",
  ical_uid: "shared",
  summary: "Private review",
  start: now + 300_000,
  end: now + 3600_000,
  all_day: false,
  status: "confirmed",
  attendees: [],
  updated_at: 1,
};
const candidates = (rows: CalendarEvent[], prefs = {}) =>
  upcomingMeetings(rows, [cal], ["a"], prefs, now);
describe("meeting reminders", () => {
  test("defaults and bounds survive malformed preferences", () => {
    expect(meetingPreferences({})).toEqual({ enabled: true, minutesBefore: 5 });
    expect(
      meetingPreferences({ meetings: { minutesBefore: NaN } }).minutesBefore,
    ).toBe(5);
    expect(
      meetingPreferences({ meetings: { minutesBefore: 100 } }).minutesBefore,
    ).toBe(60);
    expect(
      meetingPreferences({ meetings: { minutesBefore: 0 } }).minutesBefore,
    ).toBe(1);
  });
  test("lead window, wake catchup and ongoing events", () => {
    expect(candidates([event])).toEqual([event]);
    expect(candidates([{ ...event, start: now + 300_001 }])).toEqual([]);
    expect(candidates([{ ...event, start: now - 1000 }])).toHaveLength(1);
    expect(candidates([{ ...event, end: now }])).toEqual([]);
    // Started two minutes ago or more: nothing left to announce.
    expect(
      shouldAlertMeeting(
        { ...event, start: now - 120_000 },
        normalizePrefs({}),
        now,
        false,
      ),
    ).toBe(false);
  });
  test("two stages: soon in the lead window, now from half a minute before to two after", () => {
    expect(meetingStage(event, now)).toBe("soon");
    expect(meetingStage({ ...event, start: now + 31_000 }, now)).toBe("soon");
    expect(meetingStage({ ...event, start: now + 30_000 }, now)).toBe("now");
    expect(meetingStage({ ...event, start: now - 119_000 }, now)).toBe("now");
    expect(meetingStage({ ...event, start: now - 120_000 }, now)).toBe(null);
    const prefs = normalizePrefs({});
    expect(shouldAlertMeeting({ ...event, start: now }, prefs, now, false)).toBe(true);
    expect(meetingContent({ ...event, start: now }, prefs, now).body).toBe("Starting now");
    expect(meetingContent(event, { ...prefs, preview: "full" }, now)).toEqual({ title: "Private review", body: "Starts in 5 minutes" });
  });
  test("quiet hours read the person's own clock when one is given", () => {
    const prefs = normalizePrefs({ quiet: { enabled: true, from: "22:00", to: "07:00" } });
    expect(shouldAlertMeeting(event, prefs, now, false)).toBe(true);
    expect(shouldAlertMeeting(event, prefs, now, false, new Date(2026, 8, 4, 23))).toBe(false);
  });
  test("excludes all-day, cancelled, declined, removed and hidden sources", () => {
    for (const patch of [
      { all_day: true },
      { deleted: true },
      { status: "cancelled" as const },
      { my_response: "declined" as const },
      { account_id: "removed" },
      { calendar_google_id: "missing" },
    ])
      expect(candidates([{ ...event, ...patch }])).toEqual([]);
    expect(candidates([event], { hiddenCalendars: ["a:work"] })).toEqual([]);
    expect(candidates([event], { meetings: { enabled: false } })).toEqual([]);
  });
  test("copies deduplicate across accounts, rescheduled instances don't", () => {
    const copy = { ...event, _id: "copy", account_id: "b" };
    const rows = upcomingMeetings(
      [event, copy],
      [cal, { ...cal, account_id: "b" }],
      ["a", "b"],
      {},
      now,
    );
    expect(rows).toHaveLength(1);
    expect(meetingKey(copy)).toBe(meetingKey(event));
    expect(meetingKey({ ...event, start: event.start + 1 })).not.toBe(
      meetingKey(event),
    );
  });
  test("system rules respect master, account, focus, pause and quiet hours, not mail lanes", () => {
    expect(
      shouldAlertMeeting(event, normalizePrefs({ level: "none" }), now, false),
    ).toBe(true);
    for (const prefs of [
      { enabled: false },
      { accounts: { a: false } },
      { pausedUntil: Date.now() + 86_400_000 },
      { quiet: { enabled: true, from: "00:00", to: "23:59" } },
    ])
      expect(shouldAlertMeeting(event, normalizePrefs(prefs), now, false)).toBe(
        false,
      );
    expect(shouldAlertMeeting(event, normalizePrefs({}), now, true)).toBe(
      false,
    );
    expect(
      shouldAlertMeeting(
        event,
        normalizePrefs({ whenFocused: true }),
        now,
        true,
      ),
    ).toBe(true);
  });
  test("limited previews never leak the event title or guests", () => {
    expect(meetingContent(event, normalizePrefs({}), now).title).toBe(
      "Private review",
    );
    for (const preview of ["sender", "none"])
      expect(
        JSON.stringify(meetingContent(event, normalizePrefs({ preview }), now)),
      ).not.toContain("Private review");
  });
});
