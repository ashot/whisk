import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Gmail pushes each change through Pub/Sub (gmail/watch.ts) when a topic is
// configured; the client also calls `sync.refresh` on focus. This poll is
// the backstop that keeps a mailbox current when neither reaches it.
crons.interval(
  "gmail incremental sync",
  { minutes: 2 },
  internal.gmail.sync.syncAllAccounts,
  {},
);

// A Gmail watch lapses after seven days. Renewing every mailbox twice a day
// keeps a missed pass (a deploy, an outage) from ever letting one lapse.
crons.interval(
  "gmail watch renewal",
  { hours: 12 },
  internal.gmail.watch.renewAll,
  {},
);

// Drive the outbound pump for every account so a send/modify stranded by a
// crashed pump (status "inflight") is reaped and retried even when no new op
// arrives to kick the pump.
crons.interval(
  "gmail outbound pump",
  { minutes: 2 },
  internal.gmail.pump.pumpAllAccounts,
  {},
);

// Reminders promise minute-level precision ("tomorrow at 9:00"), so the clock
// ticks every minute. The query walks an index of armed rows only — a tick
// with nothing due reads nothing.
crons.interval(
  "fire due reminders",
  { minutes: 1 },
  internal.reminders.fireDue,
  {},
);

// Meetings reach the phone as they enter the person's lead window
// ("5 minutes before"), so this ticks every minute. A tick reads only the
// people with a phone, and their events inside the next hour.
crons.interval(
  "push upcoming meetings",
  { minutes: 1 },
  internal.meetingPush.sendDue,
  {},
);

// Calendars change less often than mail and carry their own cursor per
// calendar; a five minute tick keeps "up next" honest without spending the
// Calendar API quota on quiet calendars. `sync.refresh` pulls on focus too.
crons.interval(
  "calendar incremental sync",
  { minutes: 5 },
  internal.calendar.sync.syncAllAccounts,
  {},
);

// A grouping run the runtime killed never reaches finishPass; this takes
// its pulse down so the sweep does not claim to be busy forever.
crons.interval(
  "topics stale run sweep",
  { minutes: 10 },
  internal.clusters.sweepStaleRuns,
  {},
);

// Codes from the connect screen live five minutes; spent ones are kept until
// then so a second redemption is caught (connect.redeem). This clears both.
crons.interval(
  "prune app connect codes",
  { hours: 1 },
  internal.connect.pruneCodes,
  {},
);

export default crons;
