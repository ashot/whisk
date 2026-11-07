import React, { useEffect, useState } from "react";
import { useTracked } from "../store/mailStore";
import {
  calendarPreferences,
  safeCalendarUrl,
} from "@mail/shared/src/lib/calendar";
import {
  meetingKey,
  upcomingMeetings,
} from "@mail/shared/src/lib/meetingAlerts";
import { alertMeeting, openMeeting } from "../lib/meetingAlerts";
import { normalizePrefs } from "@mail/shared/src/lib/notifications";
import "../design/calendar-alerts.css";

export function MeetingAlerts(): React.ReactElement | null {
  const state = useTracked([
    (s) => s.accounts,
    (s) => s.events,
    (s) => s.calendars,
    (s) => s.clientState?.calendar,
    (s) => s.clientState?.notifications,
    (s) => s.calendarReady,
    (s) => s.calendarSyncError,
    (s) => s.calendarDialogOpen,
    (s) => s.settingsOpen,
  ]);
  const [now, setNow] = useState(Date.now);
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const interval = setInterval(tick, 15_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  const events = Object.values(state.events);
  const calendars = Object.values(state.calendars);
  const accounts = Object.values(state.accounts)
    .filter((a) => a.provider === "demo" || a.calendar_enabled)
    .map((a) => a._id);
  const prefs = calendarPreferences(state.clientState?.calendar);
  const notifications = normalizePrefs(state.clientState?.notifications);
  const meetings = state.calendarReady
    ? upcomingMeetings(events, calendars, accounts, prefs, now)
    : [];
  const systemMeetings = state.calendarReady
    ? upcomingMeetings(
        events.filter((e) => notifications.accounts[e.account_id] !== false),
        calendars,
        accounts,
        prefs,
        now,
      )
    : [];
  const signature = systemMeetings
    .map((e) => `${meetingKey(e)}:${e.updated_at}`)
    .join("|");
  useEffect(() => {
    if (!state.calendarSyncError)
      for (const event of systemMeetings) void alertMeeting(event);
  }, [
    signature,
    now,
    state.calendarSyncError,
    state.clientState?.notifications,
  ]);
  const event = meetings.find((e) => !dismissed.includes(meetingKey(e)));
  if (!event || state.calendarDialogOpen || state.settingsOpen) return null;
  const join = safeCalendarUrl(event.conference_url);
  const minutes = Math.max(1, Math.ceil((event.start - now) / 60_000));
  return (
    <aside className="meeting-alert" aria-label="Upcoming event">
      <button className="meeting-alert-body" onClick={() => openMeeting(event)}>
        <span className="meeting-alert-when">
          {event.start <= now ? "Happening now" : `In ${minutes} min`}
          {meetings.length > 1 ? ` · +${meetings.length - 1} more` : ""}
        </span>
        <strong>{event.summary || "Untitled event"}</strong>
      </button>
      {join && (
        <a
          className="meeting-alert-join"
          href={join}
          target="_blank"
          rel="noopener noreferrer"
        >
          Join
        </a>
      )}
      <button
        className="meeting-alert-dismiss"
        aria-label="Dismiss event reminder"
        onClick={() =>
          setDismissed((prev) => [...prev.slice(-99), meetingKey(event)])
        }
      >
        ×
      </button>
    </aside>
  );
}
