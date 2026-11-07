# Whisk

A fast Gmail client with your calendar built in, running at
[whisk.email](https://whisk.email), on the Mac, and on iOS. It is local first:
every screen renders from a local store, every action is an optimistic local
write that syncs behind you, and the app keeps working with no network. Every
action has a key; the mouse is optional.

This repository holds all of it: the web, desktop and mobile apps, the Convex
backend that mirrors Gmail and runs the AI features, the `whisk` command line,
and the engine they share.

## The whisk CLI

`whisk` is your mailbox in the terminal, on the same backend as the app:
every connected Gmail account, read and write. It is built for agents as much
as people. Reads never mark anything read or move it, every read takes
`--json`, and a write reaches Gmail within seconds.

### Install

It runs from source on [Bun](https://bun.sh).

```sh
git clone https://github.com/ashot/whisk.git && cd whisk
scripts/install-cli.sh           # bun install, then links whisk into ~/.local/bin
whisk auth                       # opens whisk.email in the browser to sign this terminal in
```

`whisk auth` signs the terminal in to your whisk.email account, so connect
Gmail there first. `whisk logout` revokes the login, and Settings → Terminals
in the app lists every terminal signed in.

### Use

```sh
whisk ls                                  # the inbox, newest first (--unread, --since 3d, -n 500)
whisk search "from:ada newer_than:7d"     # Gmail search over the whole mailbox
whisk read <id>                           # a whole thread, quoted trails trimmed
echo "Works for me." | whisk reply <id>
whisk archive <id> <id>                   # also trash, star, mark read, label, snooze, file into a lane
whisk summarize <id>; whisk suggest <id>  # AI summary, and a reply drafted in your voice
whisk cal                                 # calendar across connected accounts
```

`whisk --help` lists every command and `whisk <command> --help` its options.
[skills/whisk/SKILL.md](skills/whisk/SKILL.md) is the full reference.

### Give it to an agent

The CLI comes with a one-page reference for coding agents, in two forms with
the same text:

```sh
whisk snippet skill              # a skill: writes ~/.claude/skills/whisk/SKILL.md (or pass a directory)
whisk snippet install            # a "## Mail" section in ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md,
                                 # ~/.gemini/GEMINI.md and opencode's AGENTS.md, refreshed in place
```

`scripts/install-cli.sh --skill` installs the skill along with the CLI. The
checked-in [skills/whisk](skills/whisk) is the same file, for agents that
load skills from a repository. `whisk subscribe`, which wakes an agent
session when a reply arrives, arms [codecast](https://codecast.sh) triggers
and needs the `cast` CLI. Everything else works on its own.

### Point it elsewhere

By default the CLI talks to the hosted backend. To use your own deployment,
set `WHISK_CONVEX_URL`, `WHISK_SITE_URL` and `WHISK_WEB_URL` (or the matching
keys in `~/.whisk/config.json`). `whisk config` shows which backend and login
are in use, and `WHISK_HOME` moves the `~/.whisk` directory.

## What is where

| Path | What it is |
| --- | --- |
| `packages/shared` | The app store, sync registry, selectors and types, shared by web, mobile and the CLI |
| `packages/convex` | The sync backend: mirrors Gmail and Google Calendar, drains the outbox, runs lanes, topics, filters, summaries and drafts |
| `packages/web` | The Vite + React app at whisk.email. Rail, list, thread, compose; vim-style keys, command palette, undo everywhere |
| `packages/desktop` | The macOS app: the shared Electron shell around whisk.email, with an offline copy of the site |
| `packages/mobile` | The Expo iOS app |
| `packages/cli` | The `whisk` command line |
| `packages/platform` | Whisk's adapter onto the engine |
| `platform/packages` | The shared engine, also used by Codecast: local-first store and outbox (`engine`, `engine-convex`), auth, crypto, push, key bindings, the Electron shell, design tokens, the CLI kit |
| `skills/whisk` | The agent skill for the CLI |

`docs/PLATFORM_SPEC.md` describes the engine and `docs/APP_SPEC.md` and
`docs/BACKEND_SPEC.md` the app and backend. `CLAUDE.md` holds the rules every
change follows: reads render from the local store, writes are optimistic
local actions, and a server echo never clobbers a local change.

## Run it yourself

```sh
bun install
./dev.sh          # convex dev + vite in tmux; web at http://localhost:3300
```

First run: click **Try the demo mailbox** — no auth needed.

To connect real Gmail, create a Google Cloud OAuth client (web application,
redirect `<convex-site-url>/gmail/oauth/callback`, scope `gmail.modify`) and
set in the Convex deployment:

```sh
npx convex env set GMAIL_CLIENT_ID <id>
npx convex env set GMAIL_CLIENT_SECRET <secret>
npx convex env set WHISK_CREDENTIALS_KEY "$(openssl rand -base64 32)"
```

and put `VITE_CONVEX_SITE_URL` in `packages/web/.env.local`.
`WHISK_CREDENTIALS_KEY` seals the stored Gmail tokens
(`convex/lib/credentials.ts`); without it a connect fails rather than store
them in the clear. Losing it means every mailbox reconnects. After setting it
on a deployment that already holds tokens, run
`npx convex run migrations:sealCredentials`, and
`npx convex run migrations:unsealedCredentials` to confirm none are left.

### Connected apps

Another app (codecast) reaches a person's mail and calendar through Whisk,
never with Google tokens of its own. It sends them to
`whisk.email/connect?app=<id>&return=<url>&state=<s>`; they approve on one
screen and return with `?whisk_code=…&state=…`; its server trades the
one-time code at `POST <convex-site-url>/apps/token`
(`{ app_id, app_secret, code }`) for an app token it passes as `token` to the
same functions the CLI calls, within the scopes it was granted. Apps, their
scopes and return URLs live in `convex/lib/apps.ts`; each needs its secret on
the deployment:

```sh
npx convex env set WHISK_APP_SECRET_CODECAST "$(openssl rand -base64 32)"
# optional, extra return URLs for a dev or staging codecast:
npx convex env set WHISK_APP_RETURN_URLS_CODECAST http://localhost:3200/connect/whisk
```

New mail reaches the server in seconds when Gmail can push changes to it.
Without this the server polls every two minutes. In the Google Cloud project
that owns the OAuth client, create a Pub/Sub topic, let Gmail publish to it,
and point a push subscription at the server:

```sh
gcloud pubsub topics create whisk-gmail
gcloud pubsub topics add-iam-policy-binding whisk-gmail \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
gcloud pubsub subscriptions create whisk-gmail-push --topic whisk-gmail \
  --push-endpoint="<convex-site-url>/gmail/push?token=<secret>"
npx convex env set GMAIL_PUBSUB_TOPIC projects/<project>/topics/whisk-gmail
npx convex env set GMAIL_PUSH_TOKEN <secret>
```

`packages/convex/scripts/gmail-push-setup.sh` runs all of this against the
project that owns the OAuth client, once `gcloud auth login` has run.

Every mailbox starts a watch on the topic when it connects, and a cron renews
the watches twice a day. Run `npx convex run gmail/watch:renewAll` once after
setting the variables to start the watches for mailboxes already connected.

## Deploying whisk.email

The hosted deployment ships with maintainer scripts that need its
credentials and platform's deploy engine, so the public repository leaves
them out. To run your own, `npx convex deploy` in `packages/convex` and
host the `packages/web` build anywhere static.

```sh
./deploy.sh                # deploy every part that changed since it last deployed
./deploy.sh --dry-run      # the plan, and which files changed for each part
./deploy.sh web --force    # one part, even when unchanged
```

Parts, in order: `convex` (determined-fox-931 and usable-leopard-98), `web`
(the Pages project behind whisk.email, which the desktop app also loads),
`desktop` (a notarized shell release) and `mobile` (an OTA update). Uncommitted
work counts and ships. The engine is platform's `scripts/deploy.sh`: it refuses
a tree behind origin/main, builds against platform's committed HEAD, runs each
part's checks first, and records what it deployed in `.git/deploy/`.

## Desktop (macOS)

`packages/desktop` is Whisk on the shared Electron shell, `@platform/desktop`
(the same package Codecast desktop runs on). The shell loads
`https://whisk.email` and keeps a full copy of the site on disk, keyed by the
release id the site publishes in `release.json` (written by the Vite plugin
`@platform/desktop/vite`). Online, every launch checks that id and downloads
the whole release when it changed; offline, the copy is the app. The shell
updates itself from `https://dl.whisk.email/desktop` (Codecast's updater:
verified download, signature check, swap on restart), registers `mailto:` so
Whisk can be the default mail app, badges the dock, and posts notifications.
Google sign-in runs in the system browser and returns through the
`whisk://app` deep link, which the backend allowlists in
`OAUTH_ALLOWED_ORIGINS`.

```sh
cd packages/desktop
bun run install:mac        # build web, package + sign, copy to /Applications, launch
scripts/release.sh patch   # bump, build, notarize, upload to R2, verify the feed
```

Releases (maintainers only) need the R2 credentials in `~/src/codecast/packages/cli/.env.deploy`
and the `codecast` notarization keychain profile (same Apple team).

## Whisk AI

Every inbound thread is filed into a lane (Newsletters, Notifications,
Receipts, Travel, Calendar, Promotions, Security, Social) the moment it
arrives: learned sender rules first, then structural heuristics, then one
batched Haiku call for whatever neither could place. Corrections teach — press
`m`, pick a lane, and the sender's other mail re-files with it. `g c` opens
the Sweep: the inbox folded into lane cards you archive whole. `z` snoozes,
`F` watches a thread for a reply and nudges only if nobody answers, `t`
summarizes a thread, `R` drafts the reply in your own voice (distilled from
your sent mail into visible, deletable memories — see "Memories" in the
palette), and `⌘J` rewrites a draft in place.

Server side this needs one env var on the Convex deployment:

```sh
npx convex env set ANTHROPIC_API_KEY <key>
```

Without it everything degrades quietly: rules and heuristics still file,
reminders still fire, and the model features report "AI is not configured".
The demo mailbox is pre-classified and pre-seeded with memories, so the whole
surface works with zero setup.

## Notifications

New mail can interrupt you, under rules you set in Settings (`g ,`) and that
follow you to every device. One choice decides most of it — everything, real
correspondence only (the default; Whisk's lanes stay quiet), only the senders
you name, or nothing — and the panel shows what those rules would have done to
the mail you already have, so you learn the answer before 2am rather than
after. Underneath: per-lane and per-mailbox switches, senders who always or
never get through (`@example.com` covers a whole domain), quiet hours by day
with a VIP exception, sound, how much the banner says, and what the dock badge
counts. `⌘K` carries the same controls to where the mail is: pause for 30
minutes, an hour or four, or mark the sender you are reading as one you always
or never want to hear from.

The decision itself is one pure function in `packages/shared/src/lib/notifications.ts`,
so the settings preview, the desktop banners, the browser's own
notifications and the phone's pushes all answer the question identically.

The phone hears about mail through a push. The app registers its Expo push
token with the server on every launch while signed in, and the server runs
the same rules when fresh inbound mail lands (mail older than fifteen
minutes, or a mailbox still backfilling, is not news). One push per thread
names the sender and the subject at the preview level you chose; more than
three in one batch become one line naming the senders. Quiet hours run on
the phone's own clock. A tap opens the thread; the icon badge follows the
same count the dock badge does. A token Expo reports dead is dropped, and
signing out on the phone unregisters it.

Above those rules the panel reports what the operating system is doing with
them, because a person who sees nothing is owed the real reason. Neither a
browser nor Electron can be asked — `Notification.permission` answers
"granted" whether or not anything is ever drawn — so the desktop shell posts a
notification and reads macOS's own record of how it presented it. Verified
silence says so plainly and offers the one settings pane that fixes it,
whether the cause is permission or an alert style of None. "Try one" reports
what became of the notification rather than that it was sent.

## Keys

Press `?` in the app — the cheat sheet is generated from the live keymap.

## Test

```sh
bun run test          # each package's suite in its own process
bun run typecheck
```

### Topics and natural-language filters

Press `v` in the inbox (or the List / Topics switch in its header) and the
inbox shows as topics: the parts of your life the mail is about right now,
"Building the apps", "Childcare and preschool", "Money and accounts", one
section each, the one with the newest conversation first. A section is the
topic's name with a count and how many are new, its three newest
conversations as ordinary rows, and "N more" when there are more. Mail no
topic claimed is a section too, "Everything else". Nothing folds or
expands: Enter or click on a section's name opens the topic as a page of
its own with every conversation in it, and Escape brings you back. Every
section has `e` to archive all of it and `h` (or a right-click) to hide
it. Hiding takes the topic out of the list without archiving its mail; its
name waits in one line at the bottom, and a right-click there brings it
back. The plain list stays the default.

Whisk builds topics in two passes. Batches of recent inbox mail become
streams, one per run of related conversations from one sender; then one
look at the whole list gathers streams into topics, folds duplicates and
files stray senders. You only ever see the topics. New mail is grouped as
it arrives (a switch in Settings), and Regroup there starts over. Anything
you name, move or hide is yours: no regroup touches it. Edit on a topic's
page holds its description (what belongs in it, which Whisk reads when
placing mail) and the two repairs, merge and take apart. Select
conversations and press `T` to move them or make a new topic from them.
Grouping never touches Gmail labels or read state. On-demand AI (reading,
previewing or running a filter, regrouping) draws on an hourly budget per
mailbox; grouping new mail as it arrives does not.

Open **Filters** (`g f`, or from Sweep or the palette) and write one sentence: which mail,
and what to do with it. **Read and preview** shows Whisk's reading of the
condition, the actions it will take, and which of the last 200 inbox
conversations match right now, without changing anything. **Save for new mail**
applies it to mail from here on; **Save and apply to N now** also runs it on
exactly the conversations the preview listed. Each saved filter shows its state, match count, last check, and
recent matches, with pause, edit, run on inbox, and delete. Actions: archive,
trash, star, mark read, an existing Gmail label, a lane, or a topic.

The CLI exposes the same controls:

```sh
whisk topics --json
whisk topics                                    # themes, the topics in each, the rest
whisk topic settings --auto on                  # group new mail as it arrives
whisk topic regroup --account you@example.com --fresh
whisk topic show <topic-id|name>
whisk topic show none --account you@example.com  # inbox mail without a topic
whisk topic move <topic-id|name> <thread-ids...>  # or `move none` to take them out
whisk topic create "School admissions" --account you@example.com [thread-ids...]
whisk topic rename <topic-id|name> "New name" --description "What belongs here"
whisk topic merge <from> <into>
whisk topic file <topic-id|name> <theme|none>   # which theme a topic sits in
whisk topic hide <topic-id|name>; whisk topic unhide <topic-id|name>
whisk topic mute <topic-id|name>; whisk topic unmute <topic-id|name>
whisk topic dissolve <topic-id|name>
whisk filter preview "Star school admissions messages needing a reply" -a you@example.com
whisk filter add "Star school admissions messages needing a reply" -a you@example.com
whisk filter add "Trash car rental offers" -a you@example.com --apply  # also runs on the previewed matches
whisk filters --json
whisk filter edit <filter-id> "Star admissions messages needing a reply"
whisk filter pause <filter-id>; whisk filter resume <filter-id>; whisk filter rm <filter-id>
whisk filter run <filter-id> --yes  # applies to up to 300 recent inbox conversations
```

## License

Apache-2.0. See [LICENSE](LICENSE).
