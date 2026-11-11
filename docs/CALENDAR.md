# Calendar

Whisk Calendar opens as a vertical timeline. Calendars from every connected account appear together; the mail account selector does not narrow the timeline. Use the calendar menu to show or hide individual sources. Google’s selected state is the initial default, not a synchronization restriction.

## Everyday use

- Open **Calendar** in the rail, or press `g e` from mail.
- Hover a free interval to create an event there. The same control appears on keyboard focus and stays visible on touch devices. **New event** works without hovering.
- `n` creates, `t` returns to today, `[` and `]` change the starting day, and `j`/`k` move between events. Enter opens the focused event.
- The timeline covers recent days and the next two months. **Show the next two weeks** extends the feed within that range.
- Timed events use the computer’s timezone. All-day dates retain their calendar dates across timezones; the editor’s last day is inclusive.
- Open an event for details, available join links, and invitation responses. Editing and deletion require organizer ownership and writable access. Recurring events are managed in Google Calendar; individual invitations can still be answered.
- Creation and edits require a connection. Failed saves preserve the form. A save confirms Whisk accepted the change; real-account changes then queue for Google. Pending and failed provider writes remain visible and retryable.
- Google Calendar access uses `calendar.events` and `calendar.calendarlist.readonly`. Existing Gmail accounts can reconnect from Calendar without replacing their mail connection.

## Meeting reminders

Settings → Calendar controls reminders, enabled five minutes before timed events by default. Upcoming events appear in a small in-app card, with Join only when a valid meeting URL exists.

Each meeting alerts in two stages (`shared/lib/meetingAlerts.ts`): "soon" as it enters the lead window, and "now" from 30 seconds before the start to two minutes after. The app checks every 15 seconds and on focus or visibility changes, so a laptop that wakes during a meeting's first two minutes still says it is starting. All-day, declined, cancelled, disconnected and hidden-calendar events stay quiet.

- **Desktop app**: both stages go to the shell's meeting card (`packages/desktop/main.js`, page `web/meeting-alert/`), a frameless window floating top right over every app, Space and full-screen window, with the meeting's sound. It stays until joined, opened or dismissed; "now" comes back after a dismissed "soon" unless the meeting was joined, and the Dock icon jumps once. A shell from before the card gets a plain system banner.
- **Browser**: a system notification when the tab is in the background, plus the in-app card, with the meeting's sound played by the page.
- **Phone**: the server pushes each meeting once as it enters the lead window (`convex/meetingPush.ts`, a one-minute cron), time sensitive so iOS lets it through a Focus, with `meeting-push.wav`. A tap joins the meeting when it has a link. Claims in `meeting_pushes` keep it to one push per meeting across ticks and calendars.

The three sounds are synthesized by `scripts/sounds.py` into `packages/shared/assets/sounds/`; rerun it to retune them.

Alerts follow the shared notification master switch, account switches, quiet hours (on the phone's clock for pushes), pause, sound and privacy settings. Mail-only category and VIP rules do not filter meetings. Permission is requested only through an explicit settings button. Event occurrence keys suppress repeat banners and copied invitations across accounts; browser Web Locks serialize claims across tabs and local storage preserves them across reloads. A rescheduled start is a new occurrence. If storage or system notifications are unavailable, the in-app card remains available.

## Terminal

```sh
whisk cal
whisk cal today --account work
whisk cal week --json
whisk cal calendars
whisk cal add "Focus time" --start "tomorrow 9am" --duration 2h --from me@example.com
whisk cal add "Away" --start 2026-10-01 --end 2026-10-03 --all-day --calendar Personal
```

Reads include all readable synced calendars in the selected account scope, independent of the web view’s hidden-source preferences. `week` means today plus the next six days. `--from` is required when multiple accounts are connected. Creation defaults to the account’s writable primary calendar, otherwise an unambiguous writable calendar; `--calendar` accepts its exact name or id. `--guests` sends invitations on real accounts. All-day CLI ends are **exclusive**: the example covers October 1 and 2. ISO timestamps can specify offsets; local timestamps reject nonexistent spring-forward times.

## Backend boundaries

The provider mirror rolls from 14 days ago through 62 days ahead. Full reconciliation refreshes that horizon daily; incremental pages retain the same expansion/deletion parameters and recover expired Google cursors with a complete reconciliation. Events and calendar lists are paginated without silently treating truncation as success.

Provider writes use deterministic event ids, retry recovery, ordered claims and stale-completion fences. Guest edits preserve remote RSVP metadata and room/resource bookings; self RSVP only patches the self attendee. Calendar failures do not block mail writes. Demo accounts use the same dispatch/read flows without sending invitations or modifying Google.

## Reliability details

Large timelines keep all loaded delta pages subscribed, not only the initial page. Editing a title or note sends only that change and preserves exact provider timestamps, including seconds and repeated daylight-saving hours. A timed-out creation retains its retry identity; retrying with different details is rejected with recovery instructions rather than silently accepting the earlier version.

When a local write temporarily protects an event from provider updates, a fenced event-level catch-up reads it again after the write settles. This also catches organizer reschedules that arrived during an RSVP. Catch-up backs off on provider failure and does not replace newer local writes. Native conference links remain authoritative; links extracted from location or notes are recomputed when that text changes.
