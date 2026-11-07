# @platform/push

Presence aware push routing, extracted from codecast's `convex/pushRouter.ts`
and `convex/apnsVoip.ts`. Codecast has the only real push policy in the family:
aurora fans out to every device it can find, and whisk has no push at all. This
package is that policy with every database read, every event name, and every
credential injected, so all three apps can use it.

Pure TypeScript. No framework imports: no `convex/server`, no `convex/values`,
no schema. The app owns its tables and its taxonomy; the library owns the
decisions.

## The policy, in plain words

A phone is the away channel. A push that arrives while the person is looking at
the same thing on a laptop is a second copy of something they already saw, and
twenty state changes in a minute should not be twenty buzzes. So pushes do not
go straight to a delivery service. They land in an outbox, and a per person
flush decides what actually ships.

**Hold while a device is in use.** Someone with a fresh heartbeat AND fresh
keyboard or pointer input is at the screen; their push waits. A focused but
abandoned window is not "in use" — presence needs input, not just a live tab.

There are two presence signals and they hold differently. The app's own
presence row holds a push once, for three minutes, and then escalates: if the
item is still unread, the person never opened the bell, so the phone gets it
after all. Whole machine presence (the person is typing on their own Mac,
anywhere, not just in this app) keeps re-holding for as long as they are there —
escalating on a three minute timer would defeat the point, since being
heads-down in an editor for an hour is exactly the case it covers. That hold has
a one hour ceiling, because idle time resets on synthetic input too (mouse
jigglers, screen sharing, UI automation) and a machine can read "present" for
days with nobody there. A hold is a wait, never a black hole.

Machine presence only counts while an app surface is alive. The machine agent
runs independently of the app, so without that check a person with the app
closed would have every push held while nothing anywhere could display it.

**Collapse a burst.** Anyone away gets a twenty second debounce, and a flush
also ships everything due inside the next twenty five seconds. Both windows
exist so a storm of same cause rows piles up and leaves as one push. Every held
row also lands on ONE shared deadline: deadlines otherwise drift apart, and
walking away would then buzz the phone once per drifted group instead of once in
total.

**Cancel on read.** A row whose source was read (opening the bell marks
everything read) or superseded before the flush is deleted, not sent. The app
answers "was this read" through one hook; the library never looks at a
notification table.

**Fall back to a digest.** One row keeps its own words, including the subtitle
that names where it came from. Two or more have no single "where", so they
become counts grouped by the app's event names: "12 notifications", "3
permission requests · 9 sessions waiting for input". The label table is
injected, and the digest's payload names no single item on purpose — tapping a
summary should open the app, not one arbitrary item out of many.

## API

```ts
import {
  // policy, as pure functions over injected state
  resolvePresence, isClientActive, isClientAlive, isMachineActive,
  scheduleDecision, dueRows, decideFlush,
  DEFAULT_PUSH_POLICY, PRESENCE_FRESH_MS, INPUT_ACTIVE_MS,
  HOLD_WHILE_ACTIVE_MS, AWAY_DEBOUNCE_MS, BATCH_SLACK_MS, MAX_HOLD_MS,
  type PushPolicy, type Presence, type PresenceInput, type PresenceRow,
  type MachineDevice, type OutboxRow, type NewOutboxRow, type OutboxPatch,
  type FlushInput, type FlushPlan,

  // digest
  buildDigest, type DigestOptions, type TypeLabels,

  // the two functions the app wraps
  enqueuePush, flushPush,
  type PushOutboxHooks, type PushRecipient, type EnqueueRequest,
  type EnqueueResult, type FlushResult, type PushOutboxConfig,

  // transports
  createExpoTransport, createApnsTransport, createApnsVoipSender,
  createPushRouter, apnsConfigFromEnv, apnsConfigured, dedupeTargets,
  type PushMessage, type PushTarget, type PushTransport, type DeliveryResult,
  type ApnsConfig, type VoipRing, type Logger, type FetchLike,
} from "@platform/push";
```

`@platform/push/transports` exports the delivery half on its own, for an app
that wants the transports without the outbox.

### The two functions the app wraps

`enqueuePush(hooks, request, config)` replaces sending at the moment an item is
created. It reads presence, stages one row, and asks for a flush later.

`flushPush(hooks, userId, config)` is what the scheduler calls. It loads the
pending rows, applies the policy, writes the result, and delivers at most one
push.

Everything they touch is a hook:

| Hook | What the app supplies |
| --- | --- |
| `recipient(userId)` | the person: master switch, machine presence opt out, device tokens |
| `presence(userId)` | the presence row and the person's machines |
| `pending(userId)` | every staged row for that person |
| `insert` / `patch` / `remove` | the outbox writes |
| `canceled(rows)` | which staged rows the person has already read |
| `schedule(userId, delayMs)` | ask for another flush |
| `deliver(recipient, message, rows)` | add badge, channel, interruption level, then send |
| `now()` | the clock, injectable for tests |

`deliver` is deliberately the last word: badge counts, Android channels, and
iOS interruption levels come from the app's own taxonomy, so the app decorates
the finished message before handing it to a transport.

### Configuration

The policy is six numbers, all overridable:

```ts
const policy: PushPolicy = {
  ...DEFAULT_PUSH_POLICY,
  awayDebounceMs: 5_000,   // a smaller product can be quicker off the mark
  maxHoldMs: 30 * 60_000,
};
await flushPush(hooks, userId, { policy, digest: { labels } });
```

Transport credentials are configuration too. Nothing in this package carries a
real key, team id, or bundle id.

```ts
const expo = createExpoTransport({ accessToken: process.env.EXPO_ACCESS_TOKEN });

const apns = apnsConfigFromEnv(process.env, { bundleId: "com.example.app" });
// APNS_KEY_ID, APNS_TEAM_ID, APNS_AUTH_KEY (.p8 contents), APNS_ENV,
// APNS_BUNDLE_ID. The VoIP topic appends ".voip".

const router = createPushRouter({
  transports: { expo, apns: createApnsTransport(apns!) },
  defaultTransport: "expo",
});
```

Both transports dedupe by token, report the tokens the service says are dead so
the caller can clear them, and treat a failure as final: it is logged and
dropped, never retried. A retried push arrives late, and the state it described
has already moved on.

VoIP is separate because it is not an alert: `createApnsVoipSender(config).ring(token, ring)`
sends the `{ incomingCall }` payload that expo-callkit-telecom parses natively,
so a ring wakes a killed app and puts up the lock screen call UI with no app
side glue. `probe()` proves the credentials against a bogus token without
touching a device.

## How codecast adopts it

Codecast keeps its schema and its event taxonomy. It writes the hooks and
deletes the policy.

**Becomes imports.** All of `convex/pushRouter.ts` except the two Convex entry
points: `PRESENCE_FRESH_MS` through `MAX_MACHINE_HOLD_MS`,
`isDesktopActivePresence`, `isMachineActivePresence`, `readPresence`,
`summarizePushBatch`, the body of `enqueuePush`, and all of
`performPushFlush`. From `convex/apnsVoip.ts`: `b64url`, `pemToPkcs8`,
`mintApnsJwt`, `apnsConfigured`, `sendVoip`, and the payload built inside
`sendVoipRing`. From `convex/notifications.ts`, the routing half only: the Expo
message shape and the DeviceNotRegistered handling inside
`sendPushNotification`.

**Stays in codecast.** The `notifications` table and its type union.
`TYPE_LABELS` moves into the `digest.labels` option, still a codecast file. The
`CHAT_TYPES` and `ADDRESSED` sets, the unread badge count, and the Android
channel choice move into the `deliver` hook. `clearDeadPushToken` and
`clearDeadVoipToken` stay, now fed by `DeliveryResult.deadTokens`.
`reportPresence` stays, since it writes codecast's own table. Every notify
function in `notifications.ts` stays untouched: they still call one
`enqueuePush`, which is now a codecast wrapper around the library's.

What is left of `pushRouter.ts` is roughly forty lines: the `flush`
`internalMutation`, the `reportPresence` `mutation`, and a hooks object that
maps `ctx.db` reads and writes onto `PushOutboxHooks`. `apnsVoip.ts` keeps its
`internalAction` wrappers and the two `clearDead…` mutations.

The desktop side is already extracted and is not this package's business:
`packages/desktop/src/notificationRouter.js` decides which window a banner
lands in, which window may play a sound, and how N renderers reporting one
server row produce one banner. That runs in the Electron main process. This
package runs on the server and decides whether a phone hears anything at all.
The two never call each other; together they are the whole story of a
notification that must not appear twice.

## How whisk and aurora would wire it

**Aurora** has `packages/convex/convex/lib/push.ts` (collect the account's
tokens, dedupe, schedule) and `convex/push.ts` (post to Expo, log a failure).
Its dedupe and its log-do-not-retry rule are exactly `createExpoTransport`, so
that half is a drop in replacement. The policy is new: aurora has no outbox,
no presence, and no read state on a push, so today a ritual opening on the
family account buzzes every phone at once, including the phone of whoever just
opened it in the app.

Aurora would add one outbox table and a presence row, then write hooks whose
`recipient` returns the account's devices from `pushTargets`, whose `presence`
returns the reporting device's last input, and whose `deliver` calls
`createExpoTransport().send`. Because aurora fans out to a household rather
than to one person, its `PushRecipient.devices` holds several tokens, and the
router's dedupe covers the case where two family members share a token.

**Whisk** has no push at all, so it starts from the finished shape: an outbox
table, a presence row written by the client heartbeat, `enqueuePush` from
whatever write creates the item, and a scheduled `flushPush`. Its taxonomy
lives in one `digest.labels` map, and it needs only the Expo transport unless
and until it wants calls.

Neither app needs machine presence. Leaving `presence().machines` empty turns
that half of the policy off, and `machineWidePresence: false` on the recipient
skips it explicitly.

## Tests

`bun test` — 63 tests, no network. The APNs signer is exercised against a
P-256 key generated inside the test; every other HTTP call goes through an
injected fetch.

Covered: the hold while a device is active and the escalation after it, the
machine hold and its ceiling, burst collapse into one push, deadline collapse
across rows queued minutes apart, cancel on read, the digest fallback and its
injected labels, token dedup within a transport and across the router, and a
transport failure that is logged exactly once rather than retried.
