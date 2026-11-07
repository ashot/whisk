import type {
  Calendar,
  CalendarEvent,
  CalendarPreferences,
} from "./calendarTypes";
import { calendarKey, calendarVisible } from "./calendar";
import { inQuietHours, type NotificationPrefs } from "./notifications";

export function meetingPreferences(prefs: CalendarPreferences) {
  const minutes = prefs.meetings?.minutesBefore;
  return {
    enabled: prefs.meetings?.enabled !== false,
    minutesBefore:
      typeof minutes === "number" && Number.isFinite(minutes)
        ? Math.max(1, Math.min(60, Math.round(minutes)))
        : 5,
  };
}

export function meetingKey(event: CalendarEvent): string {
  return `${event.ical_uid || calendarKey(event.account_id, event.google_id)}:${event.start}`;
}

export function upcomingMeetings(
  events: CalendarEvent[],
  calendars: Calendar[],
  accounts: string[],
  prefs: CalendarPreferences,
  now: number,
): CalendarEvent[] {
  if (!meetingPreferences(prefs).enabled) return [];
  const roster = new Set(accounts);
  const visible = new Set(
    calendars
      .filter((c) => roster.has(c.account_id) && calendarVisible(c, prefs))
      .map((c) => calendarKey(c.account_id, c.google_id)),
  );
  const seen = new Set<string>();
  return events
    .filter(
      (e) =>
        !e.deleted &&
        e.status !== "cancelled" &&
        e.my_response !== "declined" &&
        !e.all_day &&
        Number.isFinite(e.start) &&
        e.end > now &&
        e.start <= now + meetingPreferences(prefs).minutesBefore * 60_000 &&
        e.end > e.start &&
        roster.has(e.account_id) &&
        visible.has(calendarKey(e.account_id, e.calendar_google_id)),
    )
    .sort((a, b) => a.start - b.start || a._id.localeCompare(b._id))
    .filter((e) => {
      const key = meetingKey(e);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function shouldAlertMeeting(
  event: CalendarEvent,
  prefs: NotificationPrefs,
  now: number,
  focused: boolean,
): boolean {
  return (
    event.start > now &&
    prefs.enabled &&
    prefs.accounts[event.account_id] !== false &&
    !(prefs.pausedUntil && prefs.pausedUntil > now) &&
    (!focused || prefs.whenFocused) &&
    !inQuietHours(new Date(now), prefs.quiet)
  );
}

export function meetingContent(
  event: CalendarEvent,
  prefs: NotificationPrefs,
  now: number,
) {
  const minutes = Math.max(1, Math.ceil((event.start - now) / 60_000));
  return {
    title:
      prefs.preview === "full"
        ? event.summary || "Untitled event"
        : "Upcoming event",
    body:
      prefs.preview === "none"
        ? "Your event starts soon."
        : `Starts in ${minutes} minute${minutes === 1 ? "" : "s"}`,
  };
}
