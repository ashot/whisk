import type {
  Calendar,
  CalendarEvent,
  CalendarPreferences,
} from "./calendarTypes";

const MINUTE = 60_000;
const pad = (n: number) => String(n).padStart(2, "0");

export function calendarKey(accountId: string, googleId: string): string {
  return `${accountId}:${googleId}`;
}

export function localDayKey(value: number | Date = Date.now()): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function utcDayStamp(key: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return NaN;
  const stamp = Date.parse(`${key}T00:00:00.000Z`);
  return Number.isFinite(stamp) &&
    new Date(stamp).toISOString().slice(0, 10) === key
    ? stamp
    : NaN;
}

export function localDayStart(key: string): number {
  if (!Number.isFinite(utcDayStamp(key))) return NaN;
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function addCalendarDays(key: string, count: number): string {
  const date = new Date(localDayStart(key));
  date.setDate(date.getDate() + count);
  return localDayKey(date);
}

export function localDateTime(day: string, time: string): number {
  if (!Number.isFinite(utcDayStamp(day)) || !/^\d{2}:\d{2}$/.test(time))
    return NaN;
  const [hour, minute] = time.split(":").map(Number);
  if (hour > 23 || minute > 59) return NaN;
  const date = new Date(localDayStart(day));
  date.setHours(hour, minute, 0, 0);
  return localDayKey(date) === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute
    ? date.getTime()
    : NaN;
}

export function localTimeInput(stamp: number): string {
  const date = new Date(stamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function eventOnDay(event: CalendarEvent, day: string): boolean {
  if (event.deleted || event.status === "cancelled" || event.end <= event.start)
    return false;
  const start = event.all_day ? utcDayStamp(day) : localDayStart(day);
  const end = event.all_day
    ? utcDayStamp(addCalendarDays(day, 1))
    : localDayStart(addCalendarDays(day, 1));
  return event.start < end && event.end > start;
}

export function eventsForDay(
  events: CalendarEvent[],
  day: string,
): CalendarEvent[] {
  return events
    .filter((event) => eventOnDay(event, day))
    .sort(
      (a, b) =>
        Number(b.all_day) - Number(a.all_day) ||
        a.start - b.start ||
        a.end - b.end ||
        a.summary.localeCompare(b.summary) ||
        a._id.localeCompare(b._id),
    );
}

export type FreeSlot = { start: number; end: number };

export function freeSlots(
  events: CalendarEvent[],
  day: string,
  now = Date.now(),
): FreeSlot[] {
  const start = localDateTime(day, "09:00");
  const end = localDateTime(day, "18:00");
  let cursor =
    day === localDayKey(now)
      ? Math.max(start, Math.ceil(now / (30 * MINUTE)) * 30 * MINUTE)
      : start;
  const slots: FreeSlot[] = [];
  for (const event of eventsForDay(events, day)) {
    if (
      event.all_day ||
      event.my_response === "declined" ||
      event.end <= cursor ||
      event.start >= end
    )
      continue;
    if (event.start - cursor >= 15 * MINUTE)
      slots.push({ start: cursor, end: Math.min(event.start, end) });
    cursor = Math.max(cursor, event.end);
  }
  if (end - cursor >= 15 * MINUTE) slots.push({ start: cursor, end });
  return slots;
}

export function defaultEventTime(
  day: string,
  events: CalendarEvent[],
  now = Date.now(),
): FreeSlot {
  const slot = freeSlots(events, day, now)[0];
  if (slot)
    return {
      start: slot.start,
      end: Math.min(slot.end, slot.start + 30 * MINUTE),
    };
  const start =
    day === localDayKey(now)
      ? (Math.floor(now / (30 * MINUTE)) + 1) * 30 * MINUTE
      : localDateTime(day, "09:00");
  return { start, end: start + 30 * MINUTE };
}

export function writableCalendar(calendar: Calendar): boolean {
  return (
    !calendar.deleted && ["owner", "writer"].includes(calendar.access_role)
  );
}

export function editableEvent(
  event: CalendarEvent,
  calendar: Calendar,
): boolean {
  return (
    writableCalendar(calendar) &&
    !event.deleted &&
    event.status !== "cancelled" &&
    !event.recurring &&
    !event.recurring_event_id &&
    (event.organizer?.self === true ||
      event.organizer?.email === calendar.google_id)
  );
}

export function calendarVisible(
  calendar: Calendar,
  prefs: CalendarPreferences,
): boolean {
  if (calendar.deleted) return false;
  return prefs.hiddenCalendars === undefined
    ? calendar.selected !== false
    : !prefs.hiddenCalendars.includes(
        calendarKey(calendar.account_id, calendar.google_id),
      );
}

export function calendarPreferences(value: unknown): CalendarPreferences {
  if (!value || typeof value !== "object") return {};
  const input = value as CalendarPreferences;
  return {
    hiddenCalendars: Array.isArray(input.hiddenCalendars)
      ? input.hiddenCalendars.filter(
          (key): key is string => typeof key === "string",
        )
      : undefined,
    meetings:
      input.meetings && typeof input.meetings === "object"
        ? input.meetings
        : undefined,
  };
}

export function safeCalendarUrl(value: string | undefined): string | null {
  if (!value || !/^https?:\/\//i.test(value)) return null;
  const parsed = URL.parse(value);
  return parsed &&
    !parsed.username &&
    !parsed.password &&
    ["https:", "http:"].includes(parsed.protocol)
    ? parsed.href
    : null;
}

export function eventDuration(
  event: Pick<CalendarEvent, "start" | "end">,
): string {
  const minutes = Math.round((event.end - event.start) / MINUTE);
  const hours = Math.floor(minutes / 60);
  return hours
    ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
    : `${minutes}m`;
}

export function eventTimeLabel(event: CalendarEvent, day?: string): string {
  if (event.all_day) return "All day";
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const start = day ? Math.max(event.start, localDayStart(day)) : event.start;
  return formatter.format(start);
}

export function calendarGuests(value: string): string[] | null {
  const emails = value
    .split(/[,;\n]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (
    emails.length > 100 ||
    emails.some(
      (email) =>
        email.length > 254 ||
        !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email),
    )
  )
    return null;
  return [...new Set(emails)];
}
