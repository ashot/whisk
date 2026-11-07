# packages/web — the mail app

One screen, no chrome debt. The measure of every decision: keystroke-to-paint feels
instant (<16ms perceived for all local actions), and a user who never touches the mouse
is never stuck.

## Views and layout

Single-column focus layout (not three-pane): a slim fixed left rail (view switcher +
labels, collapsible to icons), a thread list occupying center stage, and the open thread
REPLACING the list (list slides back on close) — like Superhuman/mutt, not like Outlook.
Rationale: reading is immersive, list is scannable, and one keyboard focus context at a
time keeps the keymap honest. Compose is a bottom-docked panel over the list/thread
(not a modal that steals the world), so reference-while-writing works.

Views: Inbox (default), Starred, Snoozed(later), Drafts, Sent, Archive (All Mail sans
inbox/trash/spam), Trash, Spam, one per user label, Search results.

URL hash reflects state (`#inbox`, `#thread/<gmailId>`, `#label/<id>`, `#search/<q>`)
so back/forward and deep links work; the store is the router (hash is a projection,
never the source of truth mid-session).

## Store (mail domain on @mail/platform)

Registry keys: accounts (collection), labels (collection, delta), threads (collection,
delta, localFirst), threadMessages (detail cache keyed by thread gmail id), drafts (meta,
localFirst), clientState (singleton, per-key LWW), pending/syncMeta/seen bookkeeping.
Ephemeral (raw set): focusedThreadId, selection set, activeView, searchQuery, compose
stack, palette/help open flags, pendingKeySequence.

Actions (all action()-decorated, optimistic, undoable where meaningful):
archiveThreads, trashThreads, markRead/Unread, toggleStar, applyLabel/removeLabel,
markSpam, deleteForever, sendMessage, saveDraft, discardDraft, snooze(later).
Undo: undoStack records inverse ops; `u` pops and replays inverse through the same
actions (which dispatch their own server ops). Toast with "Undo (u)" on destructive ops.

Message send is receiptAsyncAction-shaped? No — sends here are fire-and-forget with
optimistic sent rows + outbound queue status surfaced on the thread; keep plain action()
with client_id dedup (platform must-deliver list includes sendMessage, saveDraft).

## The keyboard engine (packages/web/src/keys/)

Hand-rolled, ~200 lines, no dependency. Requirements:
- Sequence support with timeout (500ms): `g i`, `g s`, `g t`, `] ` etc. Pending sequence
  shown as a dim ghost chip bottom-right.
- Contexts (stack): list, thread, compose, palette, help, labelPicker. Each pushes a
  keymap layer; unhandled keys fall through only where declared. Inputs/textareas
  swallow keys except explicit passthroughs (Escape, Cmd-Enter).
- Key spec strings ("g i", "shift+u", "cmd+enter", "#") parsed once at registration.
- Every binding declares: keys, context, description, handler. The help overlay (?) and
  the command palette are GENERATED from the registry — no drift possible.

Bindings (Gmail-compatible where sensible, vim where better):
- j/k next/prev thread (list AND thread view = next/prev message or thread), also arrows.
- gg/G first/last, ctrl+d/ctrl+u half-page, o or Enter open, Escape/h back to list.
- x select, shift+j/k extend selection (vim visual feel), * a select all read/unread…
  keep v1: x toggles, escape clears.
- e archive, # trash, ! spam, s star, shift+i read, shift+u unread, l label picker,
  u undo (list context; in thread context u = back-to-list like Gmail, undo is z? NO —
  keep u=undo everywhere, Escape/h is back. Honest vim: u undoes.)
- c compose, r reply, a reply-all, f forward, cmd+enter send, cmd+shift+d discard.
- gi/gs/gd/gt/ga/g# → inbox/starred/drafts/sent(t)/archive/trash; gl → label picker as view.
- / search (focus inline search bar), Escape clears, Enter commits to search view.
- cmd+k command palette (all actions + labels + views, fuzzy).
- ? help overlay — a designed cheat-sheet, grouped, searchable, every key as <KeyCap>.
- Numbers show relative positions? no. Keep restraint.

## Design system (packages/web/src/design/)

Distinctive, warm, editorial — email is READING. Avoid AI-slop dashboard grey and
purple gradients.
- Type: body/reading in a real text serif (self-hosted via @fontsource — "Newsreader"
  for message bodies, optical sizing), UI chrome in a compact grotesque
  ("Inter Tight" is banned; pick something with character — e.g. @fontsource
  "Bricolage Grotesque" for display/brand + a quiet UI sans like "Instrument Sans"),
  mono for keycaps/metadata (@fontsource "Fragment Mono" or "Spline Sans Mono").
  Final call belongs to the design pass, but NO system-default look.
- Tokens: --m-* CSS custom properties (bg, bg-raised, ink, ink-muted, ink-faint, accent,
  accent-ink, rule, star, danger, ok) defined for light and dark; light theme is the
  hero (email is read in daylight), dark fully supported, `prefers-color-scheme` +
  manual override in clientState.
- Light: paper-warm background (not pure white), near-black warm ink, one saturated
  accent used sparingly (unread dots, focus ring, send button). Dark: deep warm grey,
  not blue-black.
- Density: compact rows (~44px), generous reading measure (~68ch) in thread view.
- Motion: fast and physical — list→thread transition ~140ms transform/opacity, compose
  dock slides up, toasts rise. No springy bounce. Focus ring moves INSTANTLY (no
  transition on the j/k cursor — speed is the aesthetic).
- Empty states: designed, witty-but-quiet, one per view ("Inbox zero" moment matters).
- The unread state must be readable at a glance: ink-weight + a small accent tick, not
  a whole blue row.

## Thread list row

from (bold if unread) · subject — snippet (single line, snippet dimmed) · date (relative,
compact) · star · label chips (user labels only, tiny) · attachment glyph. Selection =
left edge bar + subtle bg. Focus cursor = 2px accent left bar + raised bg; distinct from
selection. Multi-select count pill floats bottom center with available actions as keycaps.

## Thread view

Collapsed older messages (header line only, expand with Enter/o or click; last message
expanded). Each message: from + recipients line, relative+absolute date, body (serif,
measured), attachments as chips. Quoted trails collapsed behind a "⋯ trimmed" toggle.
HTML mail: DOMPurify → sandboxed iframe (srcdoc, no scripts, remote images blocked with
a per-sender allow toggle bar), auto-height. Reply box docked at thread bottom (r focuses
it) — inline like a conversation, not a modal.

## Compose

Bottom-docked card: To/Cc/Bcc chips with autocomplete from contact frequency (derived
from synced messages), subject, body textarea (plain text v1, monospace-free, serif),
send = cmd+enter, saves draft on every pause (1s debounce through saveDraft), Escape
minimizes to a pill in the dock, discard with confirm toast + undo window.

## First-run

No account → a designed welcome screen: app name + one-line promise, two buttons:
"Try the demo mailbox" (instant — seeds fixtures, no auth) and "Connect Gmail" (OAuth
popup; disabled with a "needs GOOGLE_CLIENT_ID" note if env unset). Demo banner in the
rail with a quiet "connect your real mail" link. The demo IS the product tour: seed a
pinned onboarding thread from "Mail" itself explaining the keys (j k e # s c /) as a
beautiful email.

## Performance

- Thread list virtualized (@tanstack/react-virtual), row components memoized; wake-sig
  subscription for the list (project: id|unread|star|labels|last_at|subject-ref).
- threadMessages prefetch on focus (j/k dwell 150ms) so Enter is instant.
- All local mutations render in the same frame; server round-trips never gate paint.
- Boot: IDB hydrate → first paint < 100ms warm; convex subscriptions attach after.

## Verify

bun test for store actions/keymap; Chrome (claude-in-chrome) walkthrough: seed demo,
keyboard-only session covering every binding, screenshots of list/thread/compose/palette/
help/empty/dark, both themes.

## Lanes, sweep, reminders, whisk (added with the AI layer)

Lanes are `threads.category` projected locally: `cat:<id>` views, rail lane
rows with unread counts (only non-empty lanes render), tinted row chips
(hue from the shared taxonomy in @mail/shared/src/lib/categories.ts; the
theme owns saturation/lightness via --lane-s/--lane-l). `m` opens the
category picker (numbers 1–9 commit); filing dispatches `setCategory`, which
optimistically re-files every thread the same sender STARTED — the server
does the same and the echoes match.

Sweep (`g c`, ViewId "sweep") folds the inbox into one card per non-primary
lane, biggest first: count + unread, top senders, two sample subjects. Its
cursor is `sweepIndex` (own key context): j/k move, Enter opens the lane
view, e/# act on the whole cluster through the existing archive/trash
gestures (so undo works), Escape returns to inbox.

Reminders sync as a collection and join locally (`liveReminders`,
keyed account:gmail_id): Later = armed snoozes, Waiting = follow-up watches,
both sorted by due time with a due chip on the row ("in 3h" / "Mon 9:00 AM";
fired watches show "no reply" in accent). `z`/`F` open the time picker
(shared/lib/times.ts computes the menus), backspace clears a reminder.

Whisk gestures ride an aiBridge seam (mirror of searchBridge): `t` toggles a
serif summary card atop the open thread (loading shimmer, cached server-side),
`R` opens the reply compose immediately and fills it when the draft lands
(composeAiBusy shimmer), `⌘J` in compose opens a one-line rewrite bar with
shorter/warmer/firmer presets. Memories is a palette-opened overlay: grouped
rows, ⌘⌫ deletes, the input teaches a new preference.

## Semantic topics and natural-language filters

The inbox has a topics mode (`v`, or the List / Topics switch in its
header; a client preference, off by default). It is the inbox in sections,
one level deep: one section per topic and one for the mail no topic
claimed ("Everything else"), the section with the newest conversation
first. A section is its head (the topic's name, how many are new, how many
in all), its newest three conversations as ordinary rows, and one "N more
in …" line when it runs past three (a topic one over shows all four).
Nothing folds. Section heads and conversations are cursor stops; the "N
more" line is not. Enter or click on a head opens the topic's own page;
`e`/`#`/`z`/`x` on a head act on every conversation in the topic; `h` or
a right-click hides it. Hiding takes the topic out of the list without
archiving its mail; hidden topics leave the list, the inbox unread count,
the dock badge and notifications, and their names sit in one footer line.
Right-click a name there to bring it back.

Behind the sections the backend keeps a two level tree (themes holding
streams, one per sender's related mail) so grouping stays accurate; the
screen shows one level. A stream in a theme shows as its theme everywhere
a person sees a topic: the section, the row chip, the thread header, the
move picker (`T`), `g o` and `h`.

A topic's own page (Enter on a head, `g o`, a row chip, the rail, "N
more") is every conversation in it, newest first, flat, with a back link,
its description (its "not this" tail clamped away), its numbers, and Edit;
Escape returns to the inbox. Edit opens the editor:
name, what belongs here, merge into, take apart. `T` moves selected
threads or splits out a new named topic; a theme as the target holds the
mail directly. The rail lists the biggest topics with unread counts; its
heading opens the inbox as topics. Settings holds the two switches: group
new mail as it arrives, and Regroup. Sweep (`g c`) is lanes only. Topics
are account-specific, and explicit placements, names and hides remain
authoritative during regrouping. A running pass shows progress under the
inbox header; a failed theme pass is said on the account.

Filters open from Sweep or the palette. One gesture reads the sentence and
previews its matches (sender and subject, opening the thread); saving applies
only to new inbound messages unless the person chooses to apply it to the
previewed matches now, in which case the previewed gmail ids ride with the save
and nothing else is touched. Existing filters offer pause, edit, run on inbox and
delete, the last two behind an inline confirmation. The editor shows
mailbox, condition, actions, enabled state, hit count and recent matches. Preview
checks up to 200 recent inbox threads without applying actions. Existing-inbox
execution is explicit through the CLI. Mail bodies are untrusted data; model
answers cannot supply executable code or unvalidated actions.
