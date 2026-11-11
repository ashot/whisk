import React, { useRef, useState } from "react";
import {
  editableEvent,
  eventDuration,
  eventRelative,
  locationLabel,
  meetingProvider,
  safeCalendarUrl,
  writableCalendar,
} from "@mail/shared/src/lib/calendar";
import type {
  Calendar,
  CalendarEvent,
  CalendarResponse,
} from "@mail/shared/src/lib/calendarTypes";
import type { Account } from "../store/types";
import { mailStore } from "../store/mailStore";
import {
  calendarError,
  calendarWrite,
  calendarWriteMessage,
} from "../lib/calendarClient";
import {
  CalendarDialog,
  CloseIcon,
  useCalendarConfirmationFocus,
} from "./CalendarDialog";

export function EventDetail({
  event,
  calendar,
  account,
  onClose,
  onEdit,
}: {
  event: CalendarEvent;
  calendar: Calendar;
  account: Account;
  onClose: () => void;
  onEdit: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  useCalendarConfirmationFocus(confirm, deleteButton);
  const canEdit = editableEvent(event, calendar);
  const canRespond =
    writableCalendar(calendar) &&
    !event.organizer?.self &&
    event.attendees.some((guest) => guest.self && !guest.organizer);
  const join = safeCalendarUrl(event.conference_url);
  const relative = eventRelative(event);
  const locationUrl = safeCalendarUrl(event.location?.trim());
  const replies = event.attendees.reduce(
    (count, guest) => {
      const key = (guest.response_status ??
        "needsAction") as keyof typeof count;
      if (key in count) count[key] += 1;
      return count;
    },
    { accepted: 0, tentative: 0, declined: 0, needsAction: 0 },
  );
  const guests = [...event.attendees].sort(
    (a, b) =>
      Number(!!b.organizer) - Number(!!a.organizer) ||
      Number(!!b.self) - Number(!!a.self),
  );
  const provider = safeCalendarUrl(event.html_link);
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    ...(event.all_day ? { timeZone: "UTC" } : {}),
  });
  const clock = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const endDate = event.all_day ? event.end - 86400000 : event.end;
  const sameDay = date.format(event.start) === date.format(endDate);
  const run = async (
    action: "deleteEvent" | "rsvpEvent" | "retryCalendarWrites",
    response?: CalendarResponse,
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await calendarWrite(action, {
        account_id: event.account_id,
        calendar_google_id: event.calendar_google_id,
        google_id: event.google_id,
        ...(response ? { response } : {}),
      });
      mailStore
        .getState()
        .pushToast(
          action === "deleteEvent"
            ? account.provider === "demo"
              ? "Event deleted"
              : "Deletion queued for Google Calendar"
            : action === "retryCalendarWrites"
              ? "Retrying calendar changes"
              : calendarWriteMessage(account._id, "Reply"),
        );
      if (action === "deleteEvent") onClose();
    } catch (failure) {
      setError(calendarError(failure));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <CalendarDialog
      title={event.summary || "Event details"}
      onDismiss={() => {
        if (!busyRef.current) {
          if (confirm) setConfirm(false);
          else onClose();
        }
      }}
    >
      <div className="calendar-detail">
        <header className="calendar-dialog-head">
          <span className="calendar-dialog-source">
            <i
              className="calendar-dot"
              style={{ backgroundColor: calendar.color || "var(--m-accent)" }}
            />
            {calendar.summary}
            {!writableCalendar(calendar) && <small>Read-only</small>}
          </span>
          <button
            className="calendar-icon-button"
            aria-label="Close event details"
            disabled={busy}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>
        <h2>{event.summary || "Untitled event"}</h2>
        <div className="calendar-detail-when">
          <p>
            {date.format(event.start)}
            {!sameDay && ` – ${date.format(endDate)}`}
          </p>
          <p>
            {event.all_day
              ? sameDay
                ? "All day"
                : `All day · ${Math.round((event.end - event.start) / 86400000)} days`
              : `${clock.format(event.start)} – ${clock.format(event.end)}`}
            {!event.all_day && <small>{eventDuration(event)}</small>}
            {relative && (
              <b
                className={`calendar-tag${relative.startsWith("Now") ? " is-now" : ""}`}
              >
                {relative}
              </b>
            )}
          </p>
        </div>
        {event.pending_outbound && (
          <p className="calendar-pending" role="status">
            Changes queued for Google Calendar…
          </p>
        )}
        {event.write_error && (
          <div className="calendar-error" role="alert">
            <p>Your latest changes haven’t reached Google Calendar.</p>
            <button
              className="calendar-button"
              disabled={busy}
              onClick={() => void run("retryCalendarWrites")}
            >
              Retry changes
            </button>
          </div>
        )}
        {join && (
          <div className="calendar-join-row">
            <a
              className="calendar-button is-primary calendar-join"
              href={join}
              target="_blank"
              rel="noreferrer"
            >
              Join {meetingProvider(join) ?? "meeting"}
              <span aria-hidden>↗</span>
            </a>
            <button
              className="calendar-button is-quiet"
              onClick={() =>
                void navigator.clipboard.writeText(join).then(
                  () => mailStore.getState().pushToast("Meeting link copied"),
                  () =>
                    mailStore
                      .getState()
                      .pushToast("Couldn’t copy the link", "error"),
                )
              }
            >
              Copy link
            </button>
          </div>
        )}
        {canRespond && (
          <section className="calendar-response" aria-label="Your response">
            <span>
              Going?
              {(!event.my_response || event.my_response === "needsAction") && (
                <b className="calendar-tag is-response">Reply needed</b>
              )}
            </span>
            <div className="calendar-segmented">
              {(
                [
                  ["accepted", "Yes"],
                  ["tentative", "Maybe"],
                  ["declined", "No"],
                ] as const
              ).map(([response, label]) => (
                <button
                  key={response}
                  className={
                    event.my_response === response ? "is-selected" : ""
                  }
                  aria-pressed={event.my_response === response}
                  disabled={busy}
                  onClick={() => void run("rsvpEvent", response)}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
        )}
        {event.location && locationUrl !== join && (
          <section className="calendar-detail-section">
            <h3>Location</h3>
            <p>
              {locationUrl ? (
                <a href={locationUrl} target="_blank" rel="noreferrer">
                  {locationLabel(event.location)} ↗
                </a>
              ) : (
                <>
                  {event.location}{" "}
                  <a
                    className="calendar-detail-link"
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Map ↗
                  </a>
                </>
              )}
            </p>
          </section>
        )}
        {event.description && (
          <section className="calendar-detail-section">
            <h3>Notes</h3>
            <p className="calendar-notes">{event.description}</p>
          </section>
        )}
        {!!event.attendees.length && (
          <section className="calendar-detail-section">
            <h3>
              {event.attendees.length}{" "}
              {event.attendees.length === 1 ? "guest" : "guests"}
              <span>
                {[
                  replies.accepted && `${replies.accepted} yes`,
                  replies.tentative && `${replies.tentative} maybe`,
                  replies.declined && `${replies.declined} no`,
                  replies.needsAction && `${replies.needsAction} awaiting`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </h3>
            <ul className="calendar-guests">
              {guests.map((guest) => {
                const status = guest.response_status ?? "needsAction";
                return (
                  <li key={guest.email}>
                    <i
                      className={`calendar-rsvp-mark is-${status}`}
                      aria-hidden
                    />
                    <span title={guest.email}>
                      {guest.self ? "You" : guest.name || guest.email}
                      {guest.organizer && <small>Organizer</small>}
                      {guest.optional && <small>Optional</small>}
                    </span>
                    <span className={`calendar-rsvp is-${status}`}>
                      {(
                        {
                          accepted: "Yes",
                          declined: "No",
                          tentative: "Maybe",
                        } as Record<string, string>
                      )[status] ?? "Awaiting"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <p className="calendar-detail-account">{account.email}</p>
        {error && (
          <p className="calendar-error" role="alert">
            {error}
          </p>
        )}
        {confirm ? (
          <div className="calendar-confirm" role="alert">
            <span>
              {account.provider === "demo"
                ? "Delete this demo event?"
                : "Delete this event? Google Calendar will notify its guests."}
            </span>
            <button
              className="calendar-button is-danger"
              disabled={busy}
              onClick={() => void run("deleteEvent")}
            >
              {busy ? "Deleting…" : "Delete event"}
            </button>
            <button
              className="calendar-button"
              autoFocus
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Keep event
            </button>
          </div>
        ) : provider || canEdit ? (
          <footer className="calendar-detail-actions">
            {provider && (
              <a href={provider} target="_blank" rel="noreferrer">
                Open in Google Calendar ↗
              </a>
            )}
            {canEdit && (
              <div>
                <button
                  className="calendar-button"
                  disabled={busy}
                  onClick={onEdit}
                >
                  Edit event
                </button>
                <button
                  ref={deleteButton}
                  className="calendar-button is-danger is-quiet"
                  disabled={busy}
                  onClick={() => setConfirm(true)}
                >
                  Delete…
                </button>
              </div>
            )}
          </footer>
        ) : null}
        {(event.recurring || event.recurring_event_id) && (
          <p className="calendar-field-note">
            Repeating event. Change the series in Google Calendar.
          </p>
        )}
      </div>
    </CalendarDialog>
  );
}
