import { beforeEach, expect, test } from "bun:test";
import { mailStore } from "./mailStore";
import type { Calendar, CalendarEvent } from "../lib/calendarTypes";
import { calendarPreferences } from "../lib/calendar";
const calendar: Calendar = {
  _id: "cal-a",
  account_id: "a",
  google_id: "work",
  summary: "Work",
  access_role: "owner",
  updated_at: 1,
};
const event: CalendarEvent = {
  _id: "event-a",
  account_id: "a",
  calendar_google_id: "work",
  google_id: "event",
  summary: "Review",
  start: 1000,
  end: 2000,
  all_day: false,
  attendees: [],
  status: "confirmed",
  updated_at: 1,
};
beforeEach(() =>
  mailStore.setState({
    calendars: {},
    events: {},
    calendarOpenId: null,
    clientState: {},
    pending: {},
  }),
);
test("calendar deltas retain other sources and apply tombstones", () => {
  const state = mailStore.getState();
  state.syncTable("calendars", [
    calendar,
    { ...calendar, _id: "cal-b", account_id: "b" },
  ]);
  state.syncTable("events", [
    event,
    { ...event, _id: "event-b", account_id: "b" },
  ]);
  state.syncTable("events", [{ ...event, deleted: true, updated_at: 2 }]);
  expect(mailStore.getState().events["event-b"]).toBeDefined();
  expect(mailStore.getState().events["event-a"].deleted).toBe(true);
});
test("disconnect prunes the calendar cache and selected event", () => {
  mailStore.getState().syncTable("calendars", [calendar]);
  mailStore
    .getState()
    .syncTable("events", [
      event,
      { ...event, _id: "event-b", account_id: "b" },
    ]);
  mailStore.getState().setCalendarState({ calendarOpenId: event._id });
  mailStore.getState().pruneCalendarAccounts(["b"]);
  expect(Object.keys(mailStore.getState().events)).toEqual(["event-b"]);
  expect(mailStore.getState().calendars).toEqual({});
  expect(mailStore.getState().calendarOpenId).toBeNull();
});
test("visibility and reminders share preferences without overwriting each other", () => {
  const value = {
    hiddenCalendars: ["a:work"],
    meetings: { enabled: false, minutesBefore: 15 },
  };
  mailStore.getState().setClientPref("calendar", value);
  const prefs = calendarPreferences(mailStore.getState().clientState.calendar);
  mailStore
    .getState()
    .setClientPref("calendar", { ...prefs, hiddenCalendars: [] });
  expect(mailStore.getState().clientState.calendar.meetings).toEqual(
    value.meetings,
  );
});
