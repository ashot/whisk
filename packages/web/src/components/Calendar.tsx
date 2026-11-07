import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  addCalendarDays,
  calendarKey,
  calendarPreferences,
  calendarVisible,
  defaultEventTime,
  eventDuration,
  eventsForDay,
  eventTimeLabel,
  freeSlots,
  localDayKey,
  localDayStart,
  safeCalendarUrl,
  writableCalendar,
} from "@mail/shared/src/lib/calendar";
import type {
  Calendar as CalendarRow,
  CalendarEvent,
  CalendarEventInput,
} from "@mail/shared/src/lib/calendarTypes";
import { mailStore, useTracked } from "../store/mailStore";
import { openGmailAuth, refreshSync } from "../sync/ConvexSync";
import { calendarError, calendarWrite } from "../lib/calendarClient";
import { EventComposer } from "./EventComposer";
import { EventDetail } from "./EventDetail";
import "../design/calendar.css";
import { NavButton } from "./MobileNav";

type Draft = { start: number; end: number; event?: CalendarEvent };

export function Calendar(): React.ReactElement {
  const state = useTracked([
    (s) => s.accounts,
    (s) => s.calendars,
    (s) => s.events,
    (s) => s.clientState,
    (s) => s.calendarOpenId,
    (s) => s.calendarReady,
    (s) => s.calendarSyncError,
  ]);
  const [now, setNow] = useState(Date.now);
  const today = localDayKey(now);
  const previousToday = useRef(today);
  const [anchor, setAnchor] = useState(today);
  const [count, setCount] = useState(14);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [retrying, setRetrying] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const minimum = addCalendarDays(today, -13);
  const maximum = addCalendarDays(today, 60);
  const preferences = calendarPreferences(state.clientState.calendar);
  const accounts = Object.values(state.accounts);
  const calendars = useMemo(
    () =>
      Object.values(state.calendars)
        .filter(
          (calendar) =>
            !calendar.deleted &&
            state.accounts[calendar.account_id] &&
            (state.accounts[calendar.account_id].provider === "demo" ||
              state.accounts[calendar.account_id].calendar_enabled),
        )
        .sort(
          (a, b) =>
            a.account_id.localeCompare(b.account_id) ||
            Number(!!b.primary) - Number(!!a.primary) ||
            a.summary.localeCompare(b.summary),
        ),
    [state.calendars, state.accounts],
  );
  const visible = calendars.filter((calendar) =>
    calendarVisible(calendar, preferences),
  );
  const writable = [
    ...visible.filter(writableCalendar),
    ...calendars.filter(
      (calendar) => writableCalendar(calendar) && !visible.includes(calendar),
    ),
  ];
  const calendarMap = new Map(
    calendars.map((calendar) => [
      calendarKey(calendar.account_id, calendar.google_id),
      calendar,
    ]),
  );
  const visibleKeys = new Set(
    visible.map((calendar) =>
      calendarKey(calendar.account_id, calendar.google_id),
    ),
  );
  const events = useMemo(
    () =>
      Object.values(state.events).filter(
        (event) => !event.deleted && event.status !== "cancelled",
      ),
    [state.events],
  );
  const shownEvents = events.filter((event) =>
    visibleKeys.has(calendarKey(event.account_id, event.calendar_google_id)),
  );
  const days = Array.from({ length: count }, (_, index) =>
    addCalendarDays(anchor, index),
  ).filter((day) => day <= maximum);
  const selected = state.calendarOpenId
    ? state.events[state.calendarOpenId]
    : undefined;
  const selectedCalendar = selected
    ? calendarMap.get(
        calendarKey(selected.account_id, selected.calendar_google_id),
      )
    : undefined;
  const rememberFocus = () => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  };
  const restoreFocus = () =>
    requestAnimationFrame(() =>
      (returnFocus.current?.isConnected
        ? returnFocus.current
        : newButton.current
      )?.focus(),
    );
  const closeDetail = () => {
    mailStore.getState().setCalendarState({ calendarOpenId: null });
    restoreFocus();
  };
  const closeDraft = () => {
    setDraft(null);
    restoreFocus();
  };
  const navigate = (day: string) => {
    if (day < minimum || day > maximum) return;
    setAnchor(day);
    setCount(14);
    feed.current?.scrollTo({ top: 0 });
  };
  const create = (day = anchor, slot?: { start: number; end: number }) => {
    if (!writable.length) return;
    rememberFocus();
    setDraft(
      slot
        ? {
            start: slot.start,
            end: Math.min(slot.end, slot.start + 30 * 60000),
          }
        : defaultEventTime(day, shownEvents, Date.now()),
    );
  };
  const hiddenKeys = () =>
    calendars
      .filter(
        (calendar) =>
          !calendarVisible(
            calendar,
            calendarPreferences(mailStore.getState().clientState.calendar),
          ),
      )
      .map((calendar) => calendarKey(calendar.account_id, calendar.google_id));
  const setHidden = (hiddenCalendars: string[]) => {
    const store = mailStore.getState();
    store.setClientPref("calendar", {
      ...store.clientState.calendar,
      hiddenCalendars,
    });
  };
  const toggleCalendar = (calendar: CalendarRow) => {
    const key = calendarKey(calendar.account_id, calendar.google_id);
    const hidden = new Set(hiddenKeys());
    if (hidden.has(key)) hidden.delete(key);
    else hidden.add(key);
    setHidden([...hidden]);
  };
  const saved = (payload: CalendarEventInput) => {
    const key = calendarKey(payload.account_id, payload.calendar_google_id);
    setHidden(hiddenKeys().filter((hidden) => hidden !== key));
    const day = payload.all_day
      ? new Date(payload.start).toISOString().slice(0, 10)
      : localDayKey(payload.start);
    navigate(day);
  };
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (anchor === previousToday.current && today !== previousToday.current)
      setAnchor(today);
    previousToday.current = today;
  }, [today, anchor]);
  useEffect(() => {
    if (
      selected &&
      (selected.deleted || selected.status === "cancelled" || !selectedCalendar)
    )
      mailStore.getState().setCalendarState({ calendarOpenId: null });
  }, [selected, selectedCalendar]);
  useEffect(() => {
    const listener = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (command === "new") create();
      if (command === "today") navigate(localDayKey());
      if (command === "previous") navigate(addCalendarDays(anchor, -1));
      if (command === "next") navigate(addCalendarDays(anchor, 1));
      if (command === "down" || command === "up") {
        const buttons = Array.from(
          feed.current?.querySelectorAll<HTMLButtonElement>(
            "[data-event-id]",
          ) ?? [],
        );
        const index = buttons.findIndex(
          (button) => button === document.activeElement,
        );
        const next =
          buttons[
            index < 0
              ? command === "down"
                ? 0
                : buttons.length - 1
              : Math.max(
                  0,
                  Math.min(
                    buttons.length - 1,
                    index + (command === "down" ? 1 : -1),
                  ),
                )
          ];
        next?.focus({ preventScroll: true });
        next?.scrollIntoView({ block: "nearest" });
      }
    };
    window.addEventListener("whisk:calendar-command", listener);
    return () => window.removeEventListener("whisk:calendar-command", listener);
  });
  // Sync trouble lives in the toolbar as a one-line status, never as a card
  // above the feed: the row is always there, so the timeline never moves.
  const failing = accounts.filter((account) => account.calendar_error);
  const syncIssue =
    failing.length === 1
      ? `${failing[0].email} isn't syncing`
      : failing.length > 1
        ? `${failing.length} accounts aren't syncing`
        : state.calendarSyncError
          ? "Calendar isn't syncing"
          : null;
  const syncIssueDetail = [
    ...failing.map((account) => `${account.email}: ${account.calendar_error}`),
    state.calendarSyncError,
  ]
    .filter(Boolean)
    .join("\n");
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      for (const account of failing)
        await calendarWrite("retryCalendarWrites", { account_id: account._id });
      await refreshSync();
      mailStore.getState().pushToast("Refreshing calendar");
    } catch (failure) {
      mailStore.getState().pushToast(calendarError(failure), "error");
    } finally {
      setRetrying(false);
    }
  };
  const month = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(localDayStart(anchor));
  return (
    <div className="calendar-view">
      <header className="calendar-header">
        <NavButton />
        <div>
          <span className="calendar-eyebrow">Your time, together</span>
          <h1>
            Calendar <span>{month}</span>
          </h1>
        </div>
        <div className="calendar-header-actions">
          <button
            className="calendar-button"
            title="Today (t)"
            onClick={() => navigate(today)}
          >
            Today
          </button>
          <button
            className="calendar-icon-button"
            aria-label="Previous day"
            disabled={anchor <= minimum}
            onClick={() => navigate(addCalendarDays(anchor, -1))}
          >
            ‹
          </button>
          <button
            className="calendar-icon-button"
            aria-label="Next day"
            disabled={anchor >= maximum}
            onClick={() => navigate(addCalendarDays(anchor, 1))}
          >
            ›
          </button>
          <label className="calendar-date-jump">
            <span className="calendar-sr">Jump to date</span>
            <input
              type="date"
              aria-label="Jump to date"
              min={minimum}
              max={maximum}
              value={anchor}
              onChange={(e) => navigate(e.target.value)}
            />
          </label>
          <button
            ref={newButton}
            className="calendar-button is-primary"
            disabled={!writable.length}
            title={
              writable.length
                ? "New event (n)"
                : "Connect a writable calendar to create events"
            }
            onClick={() => create()}
          >
            + New event
          </button>
        </div>
      </header>
      <div className="calendar-toolbar">
        <span>
          Timeline <i aria-hidden>·</i>{" "}
          {Intl.DateTimeFormat()
            .resolvedOptions()
            .timeZone.replaceAll("_", " ")}
        </span>
        {syncIssue && (
          <span
            className="calendar-sync-issue"
            role="status"
            title={syncIssueDetail}
          >
            <i className="calendar-dot" aria-hidden />
            {syncIssue}
          </span>
        )}
        <details
          className="calendar-sources"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.currentTarget.open = false;
              e.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary>
            {visible.length} of {calendars.length} calendars{" "}
            <span aria-hidden>⌄</span>
          </summary>
          <div className="calendar-source-menu">
            <header>
              <strong>All accounts, one timeline</strong>
              <div>
                <button onClick={() => setHidden([])}>Show all</button>
                <button
                  onClick={() =>
                    setHidden(
                      calendars.map((calendar) =>
                        calendarKey(calendar.account_id, calendar.google_id),
                      ),
                    )
                  }
                >
                  Hide all
                </button>
              </div>
            </header>
            {accounts.map((account) => (
              <section key={account._id}>
                <h3>{account.email}</h3>
                {calendars
                  .filter((calendar) => calendar.account_id === account._id)
                  .map((calendar) => (
                    <label key={calendar._id}>
                      <input
                        type="checkbox"
                        checked={calendarVisible(calendar, preferences)}
                        onChange={() => toggleCalendar(calendar)}
                      />
                      <i
                        className="calendar-dot"
                        style={{
                          backgroundColor: calendar.color || "var(--m-accent)",
                        }}
                      />
                      <span>{calendar.summary}</span>
                      {!writableCalendar(calendar) && <small>Read-only</small>}
                    </label>
                  ))}
              </section>
            ))}
            <p>Calendar visibility is separate from your inbox selection.</p>
          </div>
        </details>
        <button
          className="calendar-refresh"
          disabled={retrying}
          onClick={() => {
            if (syncIssue) {
              void retry();
              return;
            }
            void refreshSync();
            mailStore.getState().pushToast("Calendar refresh requested");
          }}
          title={syncIssue ? syncIssueDetail : "Refresh calendars"}
        >
          {retrying ? "Retrying…" : syncIssue ? "Retry" : "Refresh"}
        </button>
      </div>
      {accounts
        .filter(
          (account) => account.provider !== "demo" && !account.calendar_enabled,
        )
        .map((account) => (
          <div className="calendar-connect" key={account._id}>
            <div>
              <strong>Bring {account.email} into your day</strong>
              <p>
                Connect Google Calendar to see and create events alongside your
                other accounts.
              </p>
            </div>
            <button
              className="calendar-button"
              onClick={() => void openGmailAuth(true, account.email)}
            >
              Connect calendar
            </button>
          </div>
        ))}
      <div
        ref={feed}
        className="calendar-feed"
        aria-label="Calendar timeline"
        aria-busy={!state.calendarReady}
      >
        {!state.calendarReady && !calendars.length ? (
          <div className="calendar-empty">
            <h2>Getting your days in order…</h2>
            <p>Your calendars will appear here as they sync.</p>
          </div>
        ) : !calendars.length ? (
          <div className="calendar-empty">
            <h2>A little space for your day.</h2>
            <p>Connect a calendar above to bring your schedule into Whisk.</p>
          </div>
        ) : !visible.length ? (
          <div className="calendar-empty">
            <h2>Your calendars are hidden.</h2>
            <p>Choose which calendars to show, or bring them all back.</p>
            <button className="calendar-button" onClick={() => setHidden([])}>
              Show all calendars
            </button>
          </div>
        ) : (
          days.map((day) => {
            const rows = eventsForDay(shownEvents, day);
            const gaps = writable.length
              ? freeSlots(shownEvents, day, now)
              : [];
            const entries = [
              ...rows.map((row) => ({
                start: row.all_day
                  ? -Infinity
                  : Math.max(row.start, localDayStart(day)),
                row,
              })),
              ...gaps.map((gap) => ({ start: gap.start, gap })),
            ].sort((a, b) => a.start - b.start);
            const isToday = day === today;
            const date = new Date(localDayStart(day));
            return (
              <section
                className={`calendar-day${isToday ? " is-today" : ""}`}
                key={day}
                aria-label={new Intl.DateTimeFormat(undefined, {
                  dateStyle: "full",
                }).format(date)}
              >
                <header className="calendar-day-heading">
                  <span>
                    {isToday
                      ? "Today"
                      : day === addCalendarDays(today, 1)
                        ? "Tomorrow"
                        : new Intl.DateTimeFormat(undefined, {
                            weekday: "short",
                          }).format(date)}
                  </span>
                  <strong>{date.getDate()}</strong>
                  <small>
                    {new Intl.DateTimeFormat(undefined, {
                      month: "short",
                    }).format(date)}
                  </small>
                </header>
                <div className="calendar-day-body">
                  {!rows.length && (
                    <p className="calendar-day-empty">
                      No plans yet
                      {day === today ? ". Make room for something good." : "."}
                    </p>
                  )}
                  {entries.map((entry, index) => {
                    if ("gap" in entry)
                      return (
                        <button
                          key={`gap-${index}`}
                          className="calendar-gap"
                          aria-label={`Create an event on ${day} at ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(entry.gap.start)}`}
                          onClick={() => create(day, entry.gap)}
                        >
                          <span className="calendar-gap-line" />
                          <span>
                            + New event{" "}
                            <small>
                              {new Intl.DateTimeFormat(undefined, {
                                timeStyle: "short",
                              }).format(entry.gap.start)}{" "}
                              · {eventDuration(entry.gap)} free
                            </small>
                          </span>
                          <span className="calendar-gap-line" />
                        </button>
                      );
                    const event = entry.row;
                    const calendar = calendarMap.get(
                      calendarKey(event.account_id, event.calendar_google_id),
                    )!;
                    const join = safeCalendarUrl(event.conference_url);
                    const live =
                      !event.all_day &&
                      event.start <= now &&
                      event.end > now &&
                      event.my_response !== "declined";
                    return (
                      <article
                        key={event._id}
                        className={`calendar-event${event.end <= now && !event.all_day ? " is-past" : ""}${event.my_response === "declined" ? " is-declined" : ""}${live ? " is-live" : ""}`}
                        style={{
                          ["--calendar-color" as string]:
                            calendar.color || "var(--m-accent)",
                        }}
                      >
                        <button
                          className="calendar-event-open"
                          data-event-id={event._id}
                          onClick={() => {
                            rememberFocus();
                            mailStore
                              .getState()
                              .setCalendarState({ calendarOpenId: event._id });
                          }}
                        >
                          <span className="calendar-event-time">
                            {eventTimeLabel(event, day)}
                            {!event.all_day && (
                              <small> {eventDuration(event)}</small>
                            )}
                          </span>
                          <span className="calendar-event-content">
                            <span className="calendar-event-title">
                              {event.summary || "Untitled event"}
                              {live && (
                                <small className="calendar-now">Now</small>
                              )}
                            </span>
                            <span className="calendar-event-meta">
                              <i className="calendar-dot" />
                              {calendar.summary}
                              {accounts.length > 1 &&
                                ` · ${state.accounts[event.account_id]?.email}`}
                              {event.location && ` · ${event.location}`}
                              {event.my_response === "declined" &&
                                " · Declined"}
                              {event.my_response === "needsAction" &&
                                " · Awaiting your reply"}
                              {event.start < localDayStart(day) &&
                                !event.all_day &&
                                " · From yesterday"}
                            </span>
                            {event.write_error ? (
                              <small className="calendar-event-error">
                                Not synced · open to retry
                              </small>
                            ) : event.pending_outbound ? (
                              <small className="calendar-pending">
                                Queued for Google Calendar
                              </small>
                            ) : null}
                          </span>
                        </button>
                        {join &&
                          event.my_response !== "declined" &&
                          event.end > now &&
                          event.start <= now + 15 * 60000 && (
                            <a
                              className="calendar-inline-join"
                              href={join}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Join ↗
                            </a>
                          )}
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })
        )}
        {!!visible.length && days.at(-1)! < maximum && (
          <button
            className="calendar-load-more"
            onClick={() => setCount((value) => value + 14)}
          >
            Show the next two weeks <span aria-hidden>↓</span>
          </button>
        )}
        {!!visible.length && (
          <p className="calendar-range-note">
            Recent days and the next two months · <kbd>j</kbd> <kbd>k</kbd> move
            · <kbd>n</kbd> new event · <kbd>t</kbd> today
          </p>
        )}
      </div>
      {draft && (
        <EventComposer
          key={draft.event?._id ?? "new"}
          calendars={writable}
          accounts={state.accounts}
          {...draft}
          onClose={closeDraft}
          onSaved={saved}
        />
      )}
      {!draft &&
        selected &&
        selectedCalendar &&
        state.accounts[selected.account_id] &&
        !selected.deleted && (
          <EventDetail
            key={selected._id}
            event={selected}
            calendar={selectedCalendar}
            account={state.accounts[selected.account_id]}
            onClose={closeDetail}
            onEdit={() => {
              setDraft({
                start: selected.start,
                end: selected.end,
                event: selected,
              });
              mailStore.getState().setCalendarState({ calendarOpenId: null });
            }}
          />
        )}
    </div>
  );
}
