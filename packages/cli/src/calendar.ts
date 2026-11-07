import type {
  Calendar,
  CalendarEventInput,
} from "@mail/shared/src/lib/calendarTypes";
import {
  addCalendarDays,
  calendarGuests,
  localDateTime,
  localDayStart,
  utcDayStamp,
  writableCalendar,
} from "@mail/shared/src/lib/calendar";
import { parseWhen } from "./when";

export function pickCalendar(
  calendars: Calendar[],
  accountId: string,
  wanted?: string,
): Calendar {
  const rows = calendars.filter(
    (c) => c.account_id === accountId && writableCalendar(c),
  );
  const matches = wanted
    ? rows.filter(
        (c) =>
          c.google_id === wanted ||
          c._id === wanted ||
          c.summary.toLowerCase() === wanted.toLowerCase(),
      )
    : rows.filter((c) => c.primary);
  if (matches.length === 1) return matches[0];
  if (!wanted && rows.length === 1) return rows[0];
  throw new Error(
    rows.length
      ? `Choose a writable calendar with --calendar <id or name>: ${rows.map((c) => `${c.summary} (${c.google_id})`).join(", ")}`
      : "No writable calendar. Connect Calendar in Whisk first.",
  );
}

export type EventOptions = {
  start: string;
  end?: string;
  duration?: string;
  allDay?: boolean;
  guests?: string;
  location?: string;
  notes?: string;
};

function eventWhen(value: string, now: number): number {
  const raw = value.trim().replace(/^(?:(?:in|at|on)\s+)+/i, "");
  if (/^\d{4}-/.test(raw)) {
    const date = raw.slice(0, 10);
    if (!Number.isFinite(utcDayStamp(date))) return NaN;
    if (raw.length === 10) return localDayStart(date);
    const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/.exec(raw);
    if (local) return localDateTime(local[1], local[2]);
    if (
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(
        raw,
      )
    )
      return NaN;
    return Date.parse(raw);
  }
  return parseWhen(raw, now, true) ?? NaN;
}

export function eventInput(
  summary: string,
  calendar: Calendar,
  opts: EventOptions,
  now = Date.now(),
): CalendarEventInput {
  if (!summary.trim() || summary.trim().length > 500)
    throw new Error("Title must be 1–500 characters.");
  if (opts.end && opts.duration)
    throw new Error("Use --end or --duration, not both.");
  if (opts.allDay && opts.duration)
    throw new Error(
      "All-day events use date-only --start and exclusive --end, not --duration.",
    );
  const start = opts.allDay
    ? utcDayStamp(opts.start)
    : eventWhen(opts.start, now);
  const duration = opts.duration ? /^(\d+)(m|h)$/.exec(opts.duration) : null;
  if (opts.duration && (!duration || Number(duration[1]) <= 0))
    throw new Error("Duration must be positive: 30m or 2h.");
  const end = opts.allDay
    ? utcDayStamp(opts.end ?? addCalendarDays(opts.start, 1))
    : opts.end
      ? eventWhen(opts.end, now)
      : start +
        (duration ? Number(duration[1]) * (duration[2] === "h" ? 60 : 1) : 30) *
          60_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new Error(
      "Use valid dates and an end after the start. Local times follow this computer’s timezone; ISO offsets are supported.",
    );
  const attendees = calendarGuests(opts.guests ?? "");
  if (!attendees)
    throw new Error("Give up to 100 valid guest emails, separated by commas.");
  if ((opts.location?.length ?? 0) > 1000 || (opts.notes?.length ?? 0) > 20000)
    throw new Error(
      "Location is limited to 1,000 characters; notes to 20,000.",
    );
  return {
    account_id: calendar.account_id,
    calendar_google_id: calendar.google_id,
    summary: summary.trim(),
    start,
    end,
    all_day: !!opts.allDay,
    attendees,
    ...(opts.location ? { location: opts.location } : {}),
    ...(opts.notes ? { description: opts.notes } : {}),
  };
}
