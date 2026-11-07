import React, { useEffect, useState } from "react";
import { mailStore, useTracked } from "../store/mailStore";
import { calendarPreferences } from "@mail/shared/src/lib/calendar";
import { meetingPreferences } from "@mail/shared/src/lib/meetingAlerts";
import {
  askNotificationPermission,
  osNotifyState,
  type OsNotifyState,
} from "../lib/notifications";

export function CalendarSettings(): React.ReactElement {
  const state = useTracked([(s) => s.clientState?.calendar]);
  const prefs = calendarPreferences(state.clientState?.calendar);
  const meetings = meetingPreferences(prefs);
  // The desktop shell answers this by asking the OS, so it is read, not
  // guessed. "prompt" is the browser state that can still be asked.
  const [permission, setPermission] = useState<OsNotifyState>("unknown");
  useEffect(() => {
    void osNotifyState().then(setPermission);
  }, []);
  const set = (patch: Partial<typeof meetings>) => {
    const current = calendarPreferences(
      mailStore.getState().clientState?.calendar,
    );
    mailStore
      .getState()
      .setClientPref("calendar", {
        ...current,
        meetings: { ...meetingPreferences(current), ...patch },
      });
  };
  return (
    <section className="settings-section">
      <h3 className="help-group-title">Calendar</h3>
      <div className="settings-row">
        <div>
          <div className="nt-master-title">Meeting reminders</div>
          <p className="nt-hint">
            For timed events on visible calendars, across all your accounts.
          </p>
        </div>
        <button
          type="button"
          className={`nt-switch${meetings.enabled ? " is-on" : ""}`}
          role="switch"
          aria-label="Meeting reminders"
          aria-checked={meetings.enabled}
          onClick={() => set({ enabled: !meetings.enabled })}
        >
          <span className="nt-switch-knob" />
        </button>
      </div>
      <label className="calendar-reminder-time">
        Remind me{" "}
        <select
          className="nt-input"
          value={meetings.minutesBefore}
          disabled={!meetings.enabled}
          onChange={(e) => set({ minutesBefore: Number(e.target.value) })}
        >
          {[1, 5, 10, 15, 30, 60].map((n) => (
            <option key={n} value={n}>
              {n} minute{n === 1 ? "" : "s"} before
            </option>
          ))}
        </select>
      </label>
      <p className="nt-hint">
        Keep Whisk open for reminders. System banners follow your notification,
        quiet-hour, sound and privacy settings above. All-day and declined
        events stay quiet.
      </p>
      {permission === "prompt" && (
        <button
          className="settings-btn"
          onClick={() =>
            void askNotificationPermission().then(setPermission)
          }
        >
          Enable system notifications
        </button>
      )}
      {permission === "denied" && (
        <p className="nt-warn">
          Notifications are blocked. Allow them in your browser or system
          settings; the in-app reminder still works.
        </p>
      )}
      {permission === "unsupported" && (
        <p className="nt-hint">This browser supports in-app reminders only.</p>
      )}
    </section>
  );
}
