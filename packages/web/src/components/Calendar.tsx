import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  addCalendarDays,
  calendarKey,
  calendarPreferences,
  calendarVisible,
  conflictingEvents,
  defaultEventTime,
  eventDuration,
  eventsForDay,
  eventTimeLabel,
  freeSlots,
  localDayKey,
  localDayStart,
  locationLabel,
  safeCalendarUrl,
  utcDayStamp,
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
  const dateInput = useRef<HTMLInputElement>(null);
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
  // Runs of empty days within a month fold into one quiet row.
  const blocks: Array<string[] & { empty: boolean }> = [];
  for (const day of days) {
    const empty =
      day !== today && !eventsForDay(shownEvents, day).length;
    const last = blocks.at(-1);
    if (
      empty &&
      last &&
      last.empty &&
      last[0].slice(0, 7) === day.slice(0, 7)
    )
      last.push(day);
    else blocks.push(Object.assign([day], { empty }));
  }
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
    // Stay put when the saved event is already on screen.
    if (day < anchor || day > days.at(-1)!) navigate(day);
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
  const zone = Intl.DateTimeFormat()
    .resolvedOptions()
    .timeZone.replaceAll("_", " ");
  const monthOf = (day: string, year = true) =>
    new Intl.DateTimeFormat(undefined, {
      month: "long",
      ...(year ? { year: "numeric" } : {}),
    }).format(localDayStart(day));
  const clock = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
  const open = (event: CalendarEvent) => {
    rememberFocus();
    mailStore.getState().setCalendarState({ calendarOpenId: event._id });
  };
  return (
    <div className="calendar-view">
      <header className="calendar-header">
        <NavButton />
        <h1>{monthOf(anchor)}</h1>
        <div className="calendar-header-actions">
          <div className="calendar-stepper" role="group" aria-label="Days">
            <button
              className="calendar-icon-button"
              aria-label="Previous day"
              title="Previous day ([)"
              disabled={anchor <= minimum}
              onClick={() => navigate(addCalendarDays(anchor, -1))}
            >
              <Chevron left />
            </button>
            <button
              className={`calendar-button${anchor === today ? " is-current" : ""}`}
              title="Today (t)"
              onClick={() => navigate(today)}
            >
              Today
            </button>
            <button
              className="calendar-icon-button"
              aria-label="Next day"
              title="Next day (])"
              disabled={anchor >= maximum}
              onClick={() => navigate(addCalendarDays(anchor, 1))}
            >
              <Chevron />
            </button>
          </div>
          <span className="calendar-date-jump">
            <button
              className="calendar-icon-button"
              aria-label="Go to date"
              title="Go to date"
              onClick={() => {
                try {
                  dateInput.current?.showPicker();
                } catch {
                  dateInput.current?.focus();
                }
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden>
                <rect x="4" y="5.5" width="16" height="14" rx="2" />
                <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
              </svg>
            </button>
            <input
              ref={dateInput}
              type="date"
              tabIndex={-1}
              aria-hidden
              min={minimum}
              max={maximum}
              value={anchor}
              onChange={(e) => e.target.value && navigate(e.target.value)}
            />
          </span>
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
            New event
          </button>
        </div>
      </header>
      <div className="calendar-toolbar">
        <details
          className="calendar-sources"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.currentTarget.open = false;
              e.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary
            aria-label={`${visible.length} of ${calendars.length} calendars shown`}
          >
            {visible.length ? (
              visible.slice(0, 4).map((calendar) => (
                <span className="calendar-source-chip" key={calendar._id}>
                  <i
                    className="calendar-dot"
                    style={{
                      backgroundColor: calendar.color || "var(--m-accent)",
                    }}
                  />
                  {calendar.summary}
                </span>
              ))
            ) : (
              <span className="calendar-source-chip">No calendars shown</span>
            )}
            {visible.length > 4 && (
              <span className="calendar-source-chip">
                +{visible.length - 4}
              </span>
            )}
            {visible.length < calendars.length && visible.length > 0 && (
              <span className="calendar-source-hidden">
                {calendars.length - visible.length} hidden
              </span>
            )}
            <Chevron down />
          </summary>
          <div className="calendar-source-menu">
            <header>
              <strong>Calendars</strong>
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
            {accounts
              .filter((account) =>
                calendars.some(
                  (calendar) => calendar.account_id === account._id,
                ),
              )
              .map((account) => (
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
                            backgroundColor:
                              calendar.color || "var(--m-accent)",
                          }}
                        />
                        <span>{calendar.summary}</span>
                        {!writableCalendar(calendar) && (
                          <small>Read-only</small>
                        )}
                      </label>
                    ))}
                </section>
              ))}
          </div>
        </details>
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
        <span className="calendar-zone" title="Times are shown in this zone">
          {zone}
        </span>
        <button
          className="calendar-refresh"
          disabled={retrying}
          aria-label={syncIssue ? "Retry calendar sync" : "Refresh calendars"}
          onClick={() => {
            if (syncIssue) {
              void retry();
              return;
            }
            void refreshSync();
            mailStore.getState().pushToast("Refreshing calendar");
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
              <strong>{account.email}</strong>
              <p>Calendar not connected</p>
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
          <div className="calendar-empty is-loading" aria-hidden>
            {[0, 1, 2].map((index) => (
              <div className="calendar-skeleton" key={index}>
                <span />
                <div>
                  <i />
                  <i />
                </div>
              </div>
            ))}
          </div>
        ) : !calendars.length ? (
          <div className="calendar-empty">
            <h2>No calendars yet</h2>
            <p>Connect a Google account above to see its events here.</p>
          </div>
        ) : !visible.length ? (
          <div className="calendar-empty">
            <h2>Every calendar is hidden</h2>
            <button className="calendar-button" onClick={() => setHidden([])}>
              Show all calendars
            </button>
          </div>
        ) : (
          blocks.map((block, blockIndex) => {
            const day = block[0];
            const previous = blocks[blockIndex - 1]?.at(-1);
            const newMonth =
              !!previous && day.slice(0, 7) !== previous.slice(0, 7);
            const monthHeading = newMonth && (
              <h2 className="calendar-month">
                {monthOf(day, day.slice(0, 4) !== today.slice(0, 4))}
              </h2>
            );
            if (block.length > 1) {
              const last = block.at(-1)!;
              const short = (key: string) =>
                new Intl.DateTimeFormat(undefined, {
                  weekday: "short",
                }).format(localDayStart(key));
              return (
                <React.Fragment key={day}>
                  {monthHeading}
                  <section
                    className={`calendar-day is-quiet${day < today ? " is-past" : ""}`}
                    aria-label={`${new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(localDayStart(day))} to ${new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(localDayStart(last))}`}
                  >
                    <header className="calendar-day-heading">
                      <strong>
                        {Number(day.slice(8))}–{Number(last.slice(8))}
                      </strong>
                    </header>
                    <div className="calendar-day-body">
                      {writable.length ? (
                        <button
                          className="calendar-gap"
                          aria-label={`New event on ${day}`}
                          onClick={() => create(day)}
                        >
                          <span className="calendar-gap-free">
                            {short(day)} – {short(last)} · nothing scheduled
                          </span>
                          <span className="calendar-gap-add">+ New event</span>
                        </button>
                      ) : (
                        <p className="calendar-day-empty">
                          {short(day)} – {short(last)} · nothing scheduled
                        </p>
                      )}
                    </div>
                  </section>
                </React.Fragment>
              );
            }
            const rows = eventsForDay(shownEvents, day);
            const clashes = conflictingEvents(shownEvents, day);
            const gaps = writable.length
              ? freeSlots(shownEvents, day, now)
              : [];
            const isToday = day === today;
            // Today's now line falls between events. While something is
            // happening, that event's own "Now" tag marks the present.
            const nowAt =
              isToday &&
              !rows.some(
                (row) =>
                  !row.all_day &&
                  row.start <= now &&
                  row.end > now &&
                  row.my_response !== "declined",
              )
                ? now
                : null;
            type Entry =
              | { start: number; row: CalendarEvent }
              | { start: number; gap: { start: number; end: number } }
              | { start: number; now: true };
            const entries: Entry[] = [
              ...rows.map((row) => ({
                start: row.all_day
                  ? -Infinity
                  : Math.max(row.start, localDayStart(day)),
                row,
              })),
              ...gaps.map((gap) => ({ start: gap.start, gap })),
              ...(nowAt === null
                ? []
                : [{ start: nowAt - 0.5, now: true as const }]),
            ].sort((a, b) => a.start - b.start);
            const date = new Date(localDayStart(day));
            const weekend = date.getDay() === 0 || date.getDay() === 6;
            const weekday = new Intl.DateTimeFormat(undefined, {
              weekday: "short",
            }).format(date);
            return (
              <React.Fragment key={day}>
                {monthHeading}
                <section
                  className={`calendar-day${isToday ? " is-today" : ""}${day < today ? " is-past" : ""}${weekend ? " is-weekend" : ""}`}
                  aria-label={new Intl.DateTimeFormat(undefined, {
                    dateStyle: "full",
                  }).format(date)}
                >
                  <header className="calendar-day-heading">
                    <strong>{date.getDate()}</strong>
                    <span>
                      {isToday ? (
                        "Today"
                      ) : day === addCalendarDays(today, 1) ? (
                        <>
                          <span className="calendar-wide">Tomorrow</span>
                          <span className="calendar-narrow">{weekday}</span>
                        </>
                      ) : (
                        weekday
                      )}
                    </span>
                  </header>
                  <div className="calendar-day-body">
                    {!rows.length && !gaps.length && (
                      <p className="calendar-day-empty">Nothing scheduled</p>
                    )}
                    {entries.map((entry, index) => {
                      if ("now" in entry)
                        return (
                          <div
                            key="now"
                            className="calendar-now-line"
                            role="separator"
                            aria-label={`Now, ${clock.format(now)}`}
                          >
                            <span>{clock.format(now)}</span>
                          </div>
                        );
                      if ("gap" in entry)
                        return (
                          <button
                            key={`gap-${index}`}
                            className="calendar-gap"
                            aria-label={`New event on ${day} at ${clock.format(entry.gap.start)}, ${eventDuration(entry.gap)} free`}
                            onClick={() => create(day, entry.gap)}
                          >
                            <span className="calendar-event-time">
                              {clock.format(entry.gap.start)}
                            </span>
                            <span className="calendar-gap-free">
                              {eventDuration(entry.gap)} free
                            </span>
                            <span className="calendar-gap-add">
                              + New event
                            </span>
                          </button>
                        );
                      const event = entry.row;
                      const calendar = calendarMap.get(
                        calendarKey(event.account_id, event.calendar_google_id),
                      )!;
                      const join = safeCalendarUrl(event.conference_url);
                      const declined = event.my_response === "declined";
                      const live =
                        !event.all_day &&
                        event.start <= now &&
                        event.end > now &&
                        !declined;
                      const past = event.all_day
                        ? day < today
                        : event.end <= now;
                      const span = event.all_day
                        ? Math.round((event.end - event.start) / 86_400_000)
                        : 1;
                      const dayOfSpan = event.all_day
                        ? Math.round(
                            (utcDayStamp(day) - event.start) / 86_400_000,
                          ) + 1
                        : 1;
                      const fromBefore =
                        !event.all_day && event.start < localDayStart(day);
                      const tags = [
                        clashes.has(event._id) && !past && "Conflict",
                        fromBefore && "Continues",
                      ].filter(Boolean);
                      const response =
                        event.my_response === "needsAction"
                          ? "Reply needed"
                          : event.my_response === "tentative"
                            ? "Maybe"
                            : declined
                              ? "Declined"
                              : null;
                      return (
                        <article
                          key={event._id}
                          className={[
                            "calendar-event",
                            event.all_day && "is-all-day",
                            past && "is-past",
                            live && "is-live",
                            declined && "is-declined",
                            event.my_response === "tentative" && "is-tentative",
                            event.my_response === "needsAction" &&
                              "is-unanswered",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          style={{
                            ["--calendar-color" as string]:
                              calendar.color || "var(--m-accent)",
                          }}
                        >
                          <button
                            className="calendar-event-open"
                            data-event-id={event._id}
                            onClick={() => open(event)}
                          >
                            <span className="calendar-event-time">
                              {event.all_day ? (
                                <>
                                  All day
                                  {span > 1 && (
                                    <small>
                                      Day {dayOfSpan} of {span}
                                    </small>
                                  )}
                                </>
                              ) : (
                                <>
                                  {eventTimeLabel(event, day)}
                                  <small>{eventDuration(event)}</small>
                                </>
                              )}
                            </span>
                            <span className="calendar-event-content">
                              <span className="calendar-event-title">
                                {event.summary || "Untitled event"}
                              </span>
                              <span className="calendar-event-meta">
                                {live && (
                                  <b className="calendar-tag is-now">
                                    Now ·{" "}
                                    {eventDuration({
                                      start: now,
                                      end: event.end,
                                    })}{" "}
                                    left
                                  </b>
                                )}
                                {response && (
                                  <b className="calendar-tag is-response">
                                    {response}
                                  </b>
                                )}
                                {tags.map((tag) => (
                                  <b
                                    className={`calendar-tag${tag === "Conflict" ? " is-conflict" : ""}`}
                                    key={String(tag)}
                                  >
                                    {tag}
                                  </b>
                                ))}
                                <span className="calendar-event-where">
                                  {[
                                    calendar.summary,
                                    accounts.length > 1 &&
                                      state.accounts[event.account_id]?.email,
                                    locationLabel(event.location),
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </span>
                              </span>
                              {event.write_error ? (
                                <small className="calendar-event-error">
                                  Not synced · open to retry
                                </small>
                              ) : event.pending_outbound ? (
                                <small className="calendar-pending">
                                  Waiting to sync
                                </small>
                              ) : null}
                            </span>
                          </button>
                          {join &&
                            !declined &&
                            event.end > now &&
                            event.start <= now + 15 * 60000 && (
                              <a
                                className="calendar-inline-join"
                                href={join}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Join
                              </a>
                            )}
                        </article>
                      );
                    })}
                  </div>
                </section>
              </React.Fragment>
            );
          })
        )}
        {!!visible.length && days.at(-1)! < maximum && (
          <button
            className="calendar-load-more"
            onClick={() => setCount((value) => value + 14)}
          >
            Show two more weeks
          </button>
        )}
        {!!visible.length && (
          <p className="calendar-range-note">
            <kbd>j</kbd>
            <kbd>k</kbd> move <kbd>↵</kbd> open <kbd>n</kbd> new <kbd>t</kbd>{" "}
            today <kbd>[</kbd>
            <kbd>]</kbd> day
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

function Chevron({
  left,
  down,
}: {
  left?: boolean;
  down?: boolean;
}): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="calendar-chevron">
      <path
        d={
          left ? "M14.5 6l-6 6 6 6" : down ? "M7 10l5 5 5-5" : "M9.5 6l6 6-6 6"
        }
      />
    </svg>
  );
}
