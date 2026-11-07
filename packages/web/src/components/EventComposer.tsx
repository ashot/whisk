import React, { useEffect, useRef, useState } from "react";
import {
  addCalendarDays,
  calendarGuests,
  calendarKey,
  localDayKey,
  localTimeInput,
} from "@mail/shared/src/lib/calendar";
import type {
  Calendar,
  CalendarEvent,
  CalendarEventInput,
} from "@mail/shared/src/lib/calendarTypes";
import type { Account } from "../store/types";
import { mailStore } from "../store/mailStore";
import {
  calendarError,
  calendarWrite,
  calendarWriteMessage,
} from "../lib/calendarClient";
import { calendarEditPatch, calendarFormSchedule } from "../lib/calendarForm";
import { CalendarDialog, useCalendarConfirmationFocus } from "./CalendarDialog";

type Props = {
  calendars: Calendar[];
  accounts: Record<string, Account>;
  start: number;
  end: number;
  event?: CalendarEvent;
  onClose: () => void;
  onSaved?: (payload: CalendarEventInput) => void;
};

export function EventComposer({
  calendars,
  accounts,
  start,
  end,
  event,
  onClose,
  onSaved,
}: Props): React.ReactElement {
  const [initial] = useState(() => ({
    title: event?.summary ?? "",
    calendar: event
      ? calendarKey(event.account_id, event.calendar_google_id)
      : calendars[0]
        ? calendarKey(calendars[0].account_id, calendars[0].google_id)
        : "",
    allDay: event?.all_day ?? false,
    startDay: event?.all_day
      ? new Date(start).toISOString().slice(0, 10)
      : localDayKey(start),
    endDay: event?.all_day
      ? addCalendarDays(new Date(end).toISOString().slice(0, 10), -1)
      : localDayKey(end),
    startTime: localTimeInput(start),
    endTime: localTimeInput(end),
    guests:
      event?.attendees
        .filter((guest) => !guest.self && !guest.organizer)
        .map((guest) => guest.email)
        .join(", ") ?? "",
    location: event?.location ?? "",
    notes: event?.description ?? "",
  }));
  const [form, setForm] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useCalendarConfirmationFocus(discard, titleRef);
  const busyRef = useRef(false);
  const clientId = useRef(crypto.randomUUID());
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const field = <K extends keyof typeof form>(
    key: K,
    value: (typeof form)[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError("");
  };
  const dismiss = () => {
    if (busyRef.current) return;
    if (dirty) setDiscard((value) => !value);
    else onClose();
  };
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  const submit = async (submission: React.FormEvent) => {
    submission.preventDefault();
    if (busyRef.current) return;
    const calendar = calendars.find(
      (row) => calendarKey(row.account_id, row.google_id) === form.calendar,
    );
    if (!calendar || !accounts[calendar.account_id]) {
      setError(
        "This calendar is no longer connected. Choose another calendar.",
      );
      return;
    }
    const attendees = calendarGuests(form.guests);
    const schedule = calendarFormSchedule(form, initial, event);
    const { start, end } = schedule;
    if (!form.title.trim()) {
      setError("Give this event a title.");
      return;
    }
    if (attendees === null) {
      setError(
        "Use valid email addresses, separated by commas. You can invite up to 100 guests.",
      );
      return;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      setError(
        "Choose a valid date and time. That local time may not exist when the clocks change.",
      );
      return;
    }
    if (end <= start) {
      setError("The event must end after it starts.");
      return;
    }
    const payload: CalendarEventInput = {
      account_id: calendar.account_id,
      calendar_google_id: calendar.google_id,
      summary: form.title.trim(),
      start,
      end,
      all_day: schedule.all_day,
      location: form.location.trim(),
      description: form.notes.trim(),
      attendees,
    };
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await calendarWrite(
        event ? "updateEvent" : "createEvent",
        event
          ? {
              account_id: event.account_id,
              calendar_google_id: event.calendar_google_id,
              google_id: event.google_id,
              patch: calendarEditPatch(form, initial, payload),
            }
          : { ...payload, client_id: clientId.current },
      );
      mailStore.getState().pushToast(calendarWriteMessage(calendar.account_id));
      onSaved?.(payload);
      onClose();
    } catch (failure) {
      setError(calendarError(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <CalendarDialog
      title={event ? "Edit event" : "New event"}
      onDismiss={dismiss}
    >
      <form className="calendar-form" onSubmit={submit}>
        <header className="calendar-dialog-head">
          <span className="calendar-eyebrow">
            {event ? "Edit event" : "Make time"}
          </span>
          <button
            type="button"
            className="calendar-icon-button"
            aria-label="Close event form"
            disabled={busy}
            onClick={dismiss}
          >
            ×
          </button>
        </header>
        <fieldset disabled={busy}>
          <label className="calendar-title-label">
            <span className="calendar-sr">Event title</span>
            <input
              ref={titleRef}
              autoFocus
              className="calendar-title-input"
              placeholder="What’s happening?"
              aria-label="Event title"
              required
              maxLength={500}
              value={form.title}
              onChange={(e) => field("title", e.target.value)}
            />
          </label>
          <label className="calendar-field">
            <span>Calendar</span>
            <select
              aria-label="Calendar"
              disabled={!!event}
              value={form.calendar}
              onChange={(e) => field("calendar", e.target.value)}
            >
              {calendars.map((row) => (
                <option
                  key={row._id}
                  value={calendarKey(row.account_id, row.google_id)}
                >
                  {row.summary} · {accounts[row.account_id]?.email}
                </option>
              ))}
            </select>
          </label>
          <label className="calendar-check">
            <input
              type="checkbox"
              checked={form.allDay}
              onChange={(e) => field("allDay", e.target.checked)}
            />
            All day
          </label>
          <div className="calendar-time-fields">
            <label className="calendar-field">
              <span>Starts</span>
              <input
                type="date"
                aria-label="Start date"
                required
                value={form.startDay}
                onChange={(e) => {
                  const day = e.target.value;
                  setForm((current) => ({
                    ...current,
                    startDay: day,
                    endDay: current.endDay < day ? day : current.endDay,
                  }));
                }}
              />
            </label>
            {!form.allDay && (
              <label className="calendar-field">
                <span className="calendar-sr">Start time</span>
                <input
                  type="time"
                  aria-label="Start time"
                  required
                  value={form.startTime}
                  onChange={(e) => field("startTime", e.target.value)}
                />
              </label>
            )}
            <label className="calendar-field">
              <span>{form.allDay ? "Last day" : "Ends"}</span>
              <input
                type="date"
                aria-label="End date"
                required
                value={form.endDay}
                onChange={(e) => field("endDay", e.target.value)}
              />
            </label>
            {!form.allDay && (
              <label className="calendar-field">
                <span className="calendar-sr">End time</span>
                <input
                  type="time"
                  aria-label="End time"
                  required
                  value={form.endTime}
                  onChange={(e) => field("endTime", e.target.value)}
                />
              </label>
            )}
          </div>
          <p className="calendar-field-note">
            {form.allDay
              ? "Includes the last day you choose."
              : `Times in ${Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll("_", " ")}.`}
          </p>
          <label className="calendar-field">
            <span>
              Guests <small>optional</small>
            </span>
            <input
              aria-label="Guest email addresses"
              placeholder="name@example.com, name@example.com"
              value={form.guests}
              onChange={(e) => field("guests", e.target.value)}
            />
          </label>
          <label className="calendar-field">
            <span>
              Location or meeting link <small>optional</small>
            </span>
            <input
              maxLength={1000}
              value={form.location}
              placeholder="A place, or paste a meeting link"
              onChange={(e) => field("location", e.target.value)}
            />
          </label>
          <label className="calendar-field">
            <span>
              Notes <small>optional</small>
            </span>
            <textarea
              rows={3}
              maxLength={20000}
              value={form.notes}
              placeholder="Anything worth knowing beforehand"
              onChange={(e) => field("notes", e.target.value)}
            />
          </label>
        </fieldset>
        {error && (
          <p className="calendar-error" role="alert">
            {error}
          </p>
        )}
        {discard && (
          <div className="calendar-confirm" role="alert">
            <span>Discard your unsaved changes?</span>
            <button
              type="button"
              className="calendar-button is-danger"
              onClick={onClose}
            >
              Discard changes
            </button>
            <button
              type="button"
              className="calendar-button"
              autoFocus
              onClick={() => setDiscard(false)}
            >
              Keep editing
            </button>
          </div>
        )}
        <footer className="calendar-form-foot">
          <span>
            {accounts[
              calendars.find(
                (row) =>
                  calendarKey(row.account_id, row.google_id) === form.calendar,
              )?.account_id ?? ""
            ]?.provider === "demo"
              ? "Demo only. No invitations are sent."
              : form.guests.trim()
                ? "Google Calendar will notify your guests."
                : "Saved to your Google Calendar."}
          </span>
          <button
            className="calendar-button is-primary"
            type="submit"
            disabled={busy}
          >
            {busy ? "Saving…" : event ? "Save changes" : "Create event"}
          </button>
        </footer>
      </form>
    </CalendarDialog>
  );
}
