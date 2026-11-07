# Calendar verification — pl-523

## Status

Calendar is released and browser-verified. Final independent regression review passed. jx785qc performed the one coordinated backend/web release; this calendar session verified the real-account connection state and an isolated demo on the exact released artifact. The earlier machine, sandbox and browser blockers recovered.

Approved OAuth scopes: `calendar.events` and `calendar.calendarlist.readonly`. No Google consent expansion, real invitations, real calendar deletions or real-mail filter actions were performed during calendar verification.

## Checks

- Combined gate before the final review fixes: **300 tests, 0 failures, 1,888 assertions across 25 files**; all seven package typechecks; web production build; whitespace check. Run by jx785qc, logs under `/tmp/whisk-combined-gate/`. The earlier Gmail queued-write timing failure did not recur.
- Final backend review fixes: **46 tests, 0 failures, 253 assertions**. Includes real authenticated Convex dispatch, mutations, sync actions and outbound pump against mocked Google HTTP, including pagination, hidden calendars, retry identity, native/text meeting links, provider removals, protected RSVP reschedules, terminal failures, stale-job fences, backoff and crash recovery.
- Final frontend/CLI focused run: **49 tests, 0 failures, 186 assertions across nine files**. Calendar dates, DST, account identity, permissions, visibility, store pruning, reminder rules/runtime, key isolation, live pagination, partial edits and CLI parsing. Web and CLI typechecks exit 0.
- Post-review combined gate: **328 tests, 0 failures, 2,025 assertions across 28 files**, all seven types and web build passed. Final four-file delta then passed **52 tests, 295 assertions**, Convex/CLI typechecks and whitespace check. UI/build were unchanged by that delta.
- CLI help checked for `cal` and `cal add`; authenticated real calendar writes were not used as tests.
- Post-release CLI smoke caught inherited `--json`/`--account` flags being ignored by nested commands. A three-line local CLI correction and eight command-parser regressions passed; the full CLI suite then passed **25 tests, 79 assertions**, plus CLI types. Authenticated `whisk cal calendars --json` and `whisk cal today --json` returned valid empty arrays. No backend/web redeploy was needed.
- Browser console: no errors during the final local demo reload and title-only edit readback, or during live create/edit/RSVP and reload verification.

## Screenshot evidence

Screenshots are actual browser captures from the isolated demo mailbox. Work and Personal are two calendars on that demo account; multiple-account identity, selection isolation and notification deduplication additionally have deterministic regression coverage.

![Light timeline: Work and Personal together](https://convex.codecast.sh/api/storage/009e3d92-8139-46fd-b714-5d054e01842c)

![Accepted invitation and guest responses](https://convex.codecast.sh/api/storage/24859e22-930e-406b-a63d-20c4862a4d14)

![Dark narrow timeline: save feedback above the meeting reminder](https://convex.codecast.sh/api/storage/a535fac8-0500-42be-a1da-6b5c8df89bd1)

![Two-day event detail at 320 pixels wide](https://convex.codecast.sh/api/storage/aaa637bc-f5b1-4962-b5d9-5274e522b938)

The following captures are from the released Pages artifact, not the local preview:

![Released Calendar: demo event persisted after reload](https://convex.codecast.sh/api/storage/04e6dc6d-9e1b-4ae6-93fd-bda3a7dca647)

![Released Calendar: accepted demo invitation at 320 pixels](https://convex.codecast.sh/api/storage/9f1ee692-82ba-4dd2-82b7-0745314b3313)

## Browser iteration ledger

| Pass | Exercise and observed result |
| --- | --- |
| 1 | Default desktop timeline: chronology, all-day ordering, calendar accents, declined styling and two simultaneous sources inspected. |
| 2 | Gap-created draft starts at the chosen 09:25 slot and defaults to 30 minutes. Title autofocus corrected and verified. |
| 3 | Invalid guest rejected without losing the draft; Escape shows discard protection and Keep editing preserves it. |
| 4 | Demo create, detail, title/location edit and full reload readback verified. |
| 5 | 390px timeline and composer: no horizontal clipping; long labels and date/time controls inspected. |
| 6 | Source picker: hide all, meaningful empty state, Escape close, reload persistence, then Show all restored. |
| 7 | Reminder settings: 10-minute selection, disabled control when reminders off, then original enabled/5-minute default restored. No OS permission request. |
| 8 | Dark timeline and invitation detail inspected; Yes RSVP persisted as Accepted for the demo self attendee. |
| 9 | Dark backdrop and empty invitation footer corrected, then screenshots rechecked. |
| 10 | Long title, long location and multiline notes saved; narrow timeline wraps title and truncates secondary metadata. |
| 11 | Real-time in-app reminder appeared before the demo event, changed to Happening now, opened the correct details and dismissed. |
| 12 | Save toast/reminder collision corrected; screenshot verifies both messages are readable. |
| 13 | Delete confirmation and Keep event/Escape cancellation tested without deleting the event. |
| 14 | All-day invalid last day rejected; corrected two-day event saved, rendered on exactly two days, and detail displayed inclusive dates. |
| 15 | 320×568 form scroll and event detail inspected; body and header widths show no horizontal overflow. |
| 16 | j/k move focus, Enter opens, n creates, Escape closes; dialog close restores the original event row. |
| 17 | Confirmation cancellation focus bug fixed: Keep editing returns to title; Keep event and Escape return to Delete trigger. Both verified. |
| 18 | Final light-mode restoration, upcoming-day navigation, accepted invitation detail, title-only edit preserving 09:25–09:55, and full reload verified after live-sync changes. |
| 19 | Released `whisk.email/#calendar`: both real mail accounts show explicit Connect calendar prompts, New event is disabled without authorized calendars, and the correct released JavaScript loads with no errors. No consent prompt was opened. |
| 20 | Exact released Pages artifact, isolated demo origin: two calendars and the current-meeting reminder render. Gap create at 13:45 uses the available 15-minute slot, saves and survives reload. Title-only edit preserves that time. Composer inspected at 390px. |
| 21 | Released demo invitation: Yes becomes Accepted and survives a full reload. At 320×568 the detail is 288px wide and body/scroll widths are both 320px. Screenshot inspected, console errors absent, viewport override reset. |

Touch target CSS and reduced-motion rules were reviewed. Actual touch and offline emulation were not performed: raw CDP access for those checks was declined and was not retried or worked around. Native mobile calendar screens are outside this scope.

## Independent review and fixes

An independent Codex critic reproduced seven defects after the initial green gate. A separate backend implementation pass fixed four; the remaining client/CLI fixes were implemented and regression-tested in the main calendar scope. The final critic confirmed five fixes, caught two remaining variants, then independently approved their corrections: blocked queued successors after terminal failure and prefixed ISO dates. Final bounded review: PASS, 43 focused tests, 246 assertions, zero failures.

| Before | After | Why |
| --- | --- | --- |
| Only the first event page stayed subscribed | Every required delta page remains live, with retired-page fences | Later creates, cancellations and reschedules must not disappear on large schedules |
| Title edits reconstructed every timestamp | Send only changed fields; preserve exact offsets and seconds | Repeated daylight-saving hours and concurrent edits must not move a meeting |
| Replacing a pasted link retained its old Join target | Separate provider-native links from text-derived links and clear removed fields | Join must follow the current meeting destination |
| Google-hidden calendars were absent from list requests | Every page explicitly requests hidden calendars | Google visibility must not remove a source from Whisk's picker |
| Protected writes consumed provider deltas without catch-up | Timestamp-fenced per-event catch-up after writes, with retry/backoff/watchdog | Organizer reschedules must not wait for tomorrow's full refresh |
| Changed retry payload silently reused an earlier create | Immutable normalized creation fingerprint rejects mismatched retries | A timed-out save must not report success while dropping later edits |
| Natural-language CLI times normalized DST gaps silently | Calendar parsing validates the requested local wall time | “2:30am” must not silently become “3:30am” |
| Dark modal backdrop bleached the page | Theme-aware dark scrim | Keep the event readable without washing out the surrounding UI |
| Invite without external actions left a blank footer | Render the footer only when actions exist | Remove an empty divider and wasted space |
| Save toast covered a meeting reminder | Toasts and pending keys stack above the reminder | Keep persistent and transient feedback separate |
| Confirmation cancel left focus on body | Return focus to title or the original Delete control | Keyboard work continues exactly where it belongs |

Google's [CalendarList reference](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list) confirms that hidden entries are excluded by default; `showHidden=true` is verified in the actual mocked request, not only in returned fixture data.

## Release receipt

- App: [Whisk Calendar](https://whisk.email/#calendar).
- Exact Pages deployment: [36ab6cb4](https://36ab6cb4.terse-mail.pages.dev/#calendar), project `terse-mail`, branch `main`.
- Backend: canonical code generation and push to the existing `determined-fox-931` deployment, exit 0. Its development label does not change that the real app uses it; no different production database was substituted.
- Release: `e9ec6d0e89913501e99d`, built September 5, 2026 at 16:53:29 UTC; [live manifest](https://whisk.email/release.json) lists 22 file hashes. The browser loaded `main-2K2i8pEF.js`.
- Release-owner CDN readback matched the JavaScript, CSS and font hashes. Served HTML differs from the uploaded artifact because Cloudflare inserts email-protection markup; that difference was inspected rather than incorrectly claiming byte-for-byte HTML identity.
- Base revision: `a385e1bd4aabd6548de7f997f4f71159d6ab69fd`. This is not a clean-commit release: the integrated, uncommitted source archive SHA-256 is `1cd6aa64a560ab14c8491a59c0377f9b082884deb14ffc0803cccdfac707aeaf`. Other sessions' work was preserved, not broadly staged.
- The local CLI has the separately tested post-release nested-option correction described above, overlay SHA-256 `2fec6361df3c0234e309a8f445a644968028e3a0fc1198825dd7e7b519c4646a`; the deployed web/backend artifact is unchanged. The stale executable that shadowed this repository's CLI was reversibly relinked by the release owner.
- Real calendar endpoints return no rows because neither real account has granted Calendar access. Therefore no existing real-event conference provenance refresh was needed. Older creates lacking a fingerprint reject uncertain retries rather than guessing.
- Live demo verification used a separate Pages origin, keeping the real site's account state and preferences intact. Only explicitly labelled demo data was created or changed.

## Explicit exclusions

- Live Google OAuth consent and real-provider write smoke tests are not implied by demo testing. Existing scopes remain unchanged unless the user reconnects.
- Real system notifications were covered by browser/native mocks, not by granting OS notification permission or sending test system banners.
- Final irreversible calendar deletion was covered through backend tests, not a browser deletion of real or demo data.
- Hover-create styling shares the keyboard-focus path; gap creation was exercised through the actual UI. Actual touch hardware was not used.
