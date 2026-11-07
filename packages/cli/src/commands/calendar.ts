import type { Command } from "commander";
import { randomUUID } from "crypto";
import { api } from "@mail/convex/convex/_generated/api";
import type {
  Calendar,
  CalendarEvent,
} from "@mail/shared/src/lib/calendarTypes";
import {
  addCalendarDays,
  eventOnDay,
  eventTimeLabel,
  localDayKey,
} from "@mail/shared/src/lib/calendar";
import { drainDeltaPages } from "@mail/shared/src/store/deltaPages";
import { dispatch, scopeAccounts, sendingAccount, session } from "../mail";
import { query } from "../client";
import { eventInput, pickCalendar, type EventOptions } from "../calendar";
import { accountOption, jsonOption } from "./shared";

type ReadOptions = { account?: string; json?: boolean };
async function timeline(period: string, opts: ReadOptions) {
  if (period !== "today" && period !== "week")
    throw new Error("Use whisk cal today or whisk cal week.");
  const accounts = scopeAccounts((await session()).accounts, opts.account);
  const ids = new Set(accounts.map((a) => a._id));
  const [calendars, first] = await Promise.all([
    query(api.calendar.read.listCalendars, {}),
    query(api.calendar.read.listEvents, {}),
  ]);
  const events = new Map<string, CalendarEvent>();
  await drainDeltaPages(
    first,
    (since) => query(api.calendar.read.listEvents, { since }),
    (rows) => rows.forEach((row) => events.set(row._id, row)),
  );
  const today = localDayKey(Date.now());
  const days = Array.from({ length: period === "today" ? 1 : 7 }, (_, i) =>
    addCalendarDays(today, i),
  );
  const visible = new Set(
    calendars
      .filter((c) => !c.deleted)
      .map((c) => `${c.account_id}:${c.google_id}`),
  );
  const rows = [...events.values()]
    .filter(
      (e) =>
        ids.has(e.account_id) &&
        visible.has(`${e.account_id}:${e.calendar_google_id}`) &&
        days.some((day) => eventOnDay(e, day)),
    )
    .sort((a, b) => a.start - b.start || a._id.localeCompare(b._id));
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const day of days) {
    console.log(`\n${day}${day === today ? " · Today" : ""}`);
    const onDay = rows.filter((e) => eventOnDay(e, day));
    for (const event of onDay) {
      const calendar = calendars.find(
        (c) =>
          c.account_id === event.account_id &&
          c.google_id === event.calendar_google_id,
      );
      console.log(
        `  ${eventTimeLabel(event, day).padEnd(10)} ${event.summary || "Untitled event"}${event.my_response === "declined" ? " · Declined" : ""}\n             ${calendar?.summary ?? "Calendar"} · ${accounts.find((a) => a._id === event.account_id)?.email} · ${event.google_id}`,
      );
    }
    if (!onDay.length) console.log("  No events");
  }
  console.log(
    "\nSynced calendars · times are local · whisk cal calendars lists sources",
  );
}

export function registerCalendar(program: Command) {
  const cal = program
    .command("cal")
    .description("Calendar timeline across your connected accounts");
  jsonOption(accountOption(cal)).action((opts: ReadOptions) =>
    timeline("today", opts),
  );
  for (const period of ["today", "week"])
    jsonOption(
      accountOption(
        cal
          .command(period)
          .description(
            period === "today"
              ? "Today’s events"
              : "Today and the next six days",
          ),
      ),
    ).action((opts: ReadOptions) => timeline(period, { ...cal.opts(), ...opts }));
  jsonOption(
    accountOption(
      cal
        .command("calendars")
        .description("List readable calendars and write permissions"),
    ),
  ).action(async (opts: ReadOptions) => {
    opts = { ...cal.opts(), ...opts };
    const accounts = scopeAccounts((await session()).accounts, opts.account);
    const rows = (await query(api.calendar.read.listCalendars, {})).filter(
      (c) => !c.deleted && accounts.some((a) => a._id === c.account_id),
    );
    console.log(
      opts.json
        ? JSON.stringify(rows, null, 2)
        : rows
            .map(
              (c) =>
                `${c.google_id}  ${c.summary}  ${c.access_role}  ${accounts.find((a) => a._id === c.account_id)?.email}`,
            )
            .join("\n") || "No calendars. Connect Calendar in Whisk first.",
    );
  });
  cal
    .command("add <title>")
    .description("Create an event; guest invitations are sent by Google")
    .requiredOption(
      "--start <when>",
      "local date/time, ISO offset, or e.g. tomorrow 9am",
    )
    .option("--end <when>", "end time; exclusive YYYY-MM-DD for all-day events")
    .option("--duration <length>", "30m or 2h; defaults to 30m")
    .option("--all-day", "date-only start/end; defaults to one day")
    .option("--from <account>", "required with multiple connected accounts")
    .option("--calendar <id-or-name>", "writable calendar; primary by default")
    .option(
      "--guests <emails>",
      "comma-separated guest emails; sends invitations",
    )
    .option("--location <text>")
    .option("--notes <text>")
    .option("--json")
    .action(
      async (
        title: string,
        opts: EventOptions & {
          from?: string;
          calendar?: string;
          json?: boolean;
        },
      ) => {
        opts = { ...cal.opts(), ...opts };
        const account = sendingAccount((await session()).accounts, opts.from);
        const calendars = (await query(
          api.calendar.read.listCalendars,
          {},
        )) as Calendar[];
        const input = eventInput(
          title,
          pickCalendar(calendars, account._id, opts.calendar),
          opts,
        );
        const result = await dispatch("createEvent", {
          ...input,
          client_id: randomUUID(),
        });
        console.log(
          opts.json
            ? JSON.stringify(result, null, 2)
            : account.provider === "demo"
              ? "Event saved in the demo calendar."
              : "Event queued for Google Calendar. Check Whisk for sync status.",
        );
      },
    );
}
