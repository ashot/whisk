import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  calendarEditPatch,
  calendarFormSchedule,
  type CalendarFormValues,
} from "./calendarForm";
import type {
  CalendarEvent,
  CalendarEventInput,
} from "@mail/shared/src/lib/calendarTypes";

const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  process.env.TZ = zone;
});
const form: CalendarFormValues = {
  title: "Review",
  allDay: false,
  startDay: "2026-11-01",
  endDay: "2026-11-01",
  startTime: "01:30",
  endTime: "02:30",
  guests: "",
  location: "",
  notes: "",
};
const event: CalendarEvent = {
  _id: "e",
  account_id: "a",
  calendar_google_id: "work",
  google_id: "e",
  summary: "Review",
  start: Date.parse("2026-11-01T01:30:15-05:00"),
  end: Date.parse("2026-11-01T02:30:15-05:00"),
  all_day: false,
  status: "confirmed",
  attendees: [],
  updated_at: 1,
};
const payload: CalendarEventInput = {
  account_id: "a",
  calendar_google_id: "work",
  summary: "Renamed",
  start: event.start,
  end: event.end,
  all_day: false,
  location: "",
  description: "",
  attendees: [],
};

test("title-only edits preserve repeated-hour offsets and seconds", () => {
  const changed = { ...form, title: "Renamed" };
  expect(calendarFormSchedule(changed, form, event)).toEqual({
    start: event.start,
    end: event.end,
    all_day: false,
  });
  expect(calendarEditPatch(changed, form, payload)).toEqual({
    summary: "Renamed",
  });
});
test("untouched fields do not overwrite remote changes received while editing", () => {
  const changed = { ...form, notes: "A note" };
  const latest = {
    ...event,
    start: event.start + 3600000,
    end: event.end + 3600000,
  };
  expect(calendarFormSchedule(changed, form, latest).start).toBe(latest.start);
  expect(
    calendarEditPatch(changed, form, { ...payload, description: "A note" }),
  ).toEqual({ description: "A note" });
});
test("changing one schedule boundary leaves the other exact", () => {
  const changed = { ...form, endTime: "03:00" };
  const schedule = calendarFormSchedule(changed, form, event);
  expect(schedule.start).toBe(event.start);
  expect(schedule.end).toBe(Date.parse("2026-11-01T03:00:00-05:00"));
  expect(calendarEditPatch(changed, form, { ...payload, ...schedule })).toEqual(
    { end: schedule.end },
  );
});
test("all-day conversion uses inclusive dates and changed guests remain explicit", () => {
  const changed = { ...form, allDay: true, guests: "ada@example.com" };
  const schedule = calendarFormSchedule(changed, form, event);
  expect(schedule).toEqual({
    start: Date.UTC(2026, 10, 1),
    end: Date.UTC(2026, 10, 2),
    all_day: true,
  });
  expect(
    calendarEditPatch(changed, form, {
      ...payload,
      ...schedule,
      attendees: ["ada@example.com"],
    }),
  ).toEqual({ ...schedule, attendees: ["ada@example.com"] });
});
