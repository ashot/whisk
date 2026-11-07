// The push routing policy, as pure decisions over injected state.
//
// A phone is the "away" channel. Every push therefore goes through an outbox
// with a per recipient flush instead of straight to a delivery service, and
// four rules decide what the phone actually gets:
//
//  - HOLD while a device is active. Someone at their desk already sees the
//    banner and the badge on that screen; buzzing the phone repeats it. Client
//    presence holds once and then escalates ("you never opened it"), machine
//    presence keeps holding while the person is at the computer, with a
//    ceiling so a hold is a wait and never a black hole.
//  - COLLAPSE a burst. Rows wait out a debounce, then everything pending for
//    one person ships as ONE push. Twenty sessions changing state is one buzz.
//  - CANCEL on read. A row whose source was read (or superseded) before the
//    flush is dropped, not sent.
//  - DIGEST fallback. When a hold or a debounce collected more than one row,
//    the send is a counted summary rather than one arbitrary row (buildDigest
//    in ./digest).
//
// Nothing here reads a database or names an event type. The app loads the
// rows, answers "was this read", and owns its own taxonomy; these functions
// only decide.

export interface PushPolicy {
  /** A presence heartbeat older than this means the surface is gone. */
  presenceFreshMs: number;
  /** Input older than this means the surface is open but abandoned. */
  inputActiveMs: number;
  /** How long a push waits while a device is active before escalating. */
  holdWhileActiveMs: number;
  /** Debounce on the away path — the window a burst collapses into. */
  awayDebounceMs: number;
  /** A flush also ships rows due this soon, so a spread burst rides one send. */
  batchSlackMs: number;
  /** Ceiling on the machine presence hold, measured from the oldest row. */
  maxHoldMs: number;
}

// Clients heartbeat every ~30s while visible and background tabs get throttled
// to about one a minute, so "fresh" tolerates two missed beats. Sleeping the
// machine stops the heartbeat, and presence goes stale on its own.
export const PRESENCE_FRESH_MS = 150_000;
// Active also requires real input this recently. A focused but abandoned
// window is not active.
export const INPUT_ACTIVE_MS = 3 * 60_000;
export const HOLD_WHILE_ACTIVE_MS = 3 * 60_000;
// Long enough for a storm of same cause rows to pile up, short enough that a
// lone push still feels immediate.
export const AWAY_DEBOUNCE_MS = 20_000;
export const BATCH_SLACK_MS = 25_000;
// Machine presence waits for the person to leave rather than escalating on a
// timer, which needs a backstop: idle time resets on synthetic input too
// (mouse jigglers, screen sharing, UI automation), so a machine can read
// present for days with nobody there.
export const MAX_HOLD_MS = 60 * 60_000;

export const DEFAULT_PUSH_POLICY: PushPolicy = {
  presenceFreshMs: PRESENCE_FRESH_MS,
  inputActiveMs: INPUT_ACTIVE_MS,
  holdWhileActiveMs: HOLD_WHILE_ACTIVE_MS,
  awayDebounceMs: AWAY_DEBOUNCE_MS,
  batchSlackMs: BATCH_SLACK_MS,
  maxHoldMs: MAX_HOLD_MS,
};

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/** One app surface reporting in: a browser tab, a desktop window. */
export interface PresenceRow {
  lastSeen: number;
  lastInputAt: number;
}

/** One machine the person owns, reporting whole machine input. */
export interface MachineDevice {
  lastSeen: number;
  lastInputAt?: number;
  /** A server or a hosted box is never where the person is sitting. */
  isRemote?: boolean;
}

export interface PresenceInput {
  /** The app's own presence row, if the app tracks one. */
  client?: PresenceRow | null;
  /** The person's machines, for the wider signal. */
  machines?: MachineDevice[];
  /** Widen presence to whole machines. Absent reads as ON. */
  machineWidePresence?: boolean;
}

export interface Presence {
  /** A human is using an app surface right now. */
  clientActive: boolean;
  /** An app surface is still running, even if the human is elsewhere. */
  clientAlive: boolean;
  /** A human is touching one of their own machines right now. */
  machineActive: boolean;
  active: boolean;
}

export function isClientActive(
  presence: PresenceRow | null | undefined,
  now: number,
  policy: PushPolicy = DEFAULT_PUSH_POLICY,
): boolean {
  if (!presence) return false;
  return (
    now - presence.lastSeen < policy.presenceFreshMs &&
    now - presence.lastInputAt < policy.inputActiveMs
  );
}

/** Still heartbeating, so a surface exists that can display the item. */
export function isClientAlive(
  presence: PresenceRow | null | undefined,
  now: number,
  policy: PushPolicy = DEFAULT_PUSH_POLICY,
): boolean {
  return !!presence && now - presence.lastSeen < policy.presenceFreshMs;
}

/**
 * A device counts only when it is not remote, still heartbeating, and
 * reporting input. A device that reports no input at all contributes nothing
 * rather than counting as present, so every uncertain case degrades to away
 * and keeps pushes flowing instead of swallowing them.
 */
export function isMachineActive(
  devices: MachineDevice[] | undefined,
  now: number,
  policy: PushPolicy = DEFAULT_PUSH_POLICY,
): boolean {
  if (!devices) return false;
  return devices.some(
    (d) =>
      !d.isRemote &&
      d.lastInputAt !== undefined &&
      now - d.lastSeen < policy.presenceFreshMs &&
      now - d.lastInputAt < policy.inputActiveMs,
  );
}

/**
 * The two signals stay separate because they hold pushes differently. Machine
 * presence only counts while an app surface is alive: the machine agent runs
 * independently of the app, so without that check a person with the app closed
 * would have every push held while nothing anywhere could display it.
 */
export function resolvePresence(
  input: PresenceInput,
  now: number,
  policy: PushPolicy = DEFAULT_PUSH_POLICY,
): Presence {
  const clientActive = isClientActive(input.client, now, policy);
  const clientAlive = isClientAlive(input.client, now, policy);
  const wide = input.machineWidePresence ?? true;
  const machineActive =
    wide && clientAlive ? isMachineActive(input.machines, now, policy) : false;
  return {
    clientActive,
    clientAlive,
    machineActive,
    active: clientActive || machineActive,
  };
}

// ---------------------------------------------------------------------------
// Outbox rows
// ---------------------------------------------------------------------------

/** A staged push. The app stores these; the library only reasons about them. */
export interface OutboxRow {
  id: string;
  userId: string;
  createdAt: number;
  dueAt: number;
  /** This row has already had its one client presence deferral. */
  deferred: boolean;
  /** The app's own event name. The library never interprets it. */
  type?: string;
  title: string;
  /** Second line on iOS. Only a single row send shows it. */
  subtitle?: string;
  body: string;
  data?: unknown;
  /** The item this push is about, so reading it can cancel the push. */
  sourceId?: string;
}

export type NewOutboxRow = Omit<OutboxRow, "id">;

/** What a row patch may change. Nothing else about a row ever moves. */
export interface OutboxPatch {
  dueAt?: number;
  deferred?: boolean;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * When a freshly queued row should first come up for a send. An active device
 * buys the hold window; anyone away gets the short debounce that collapses a
 * burst. A row queued while active is marked deferred, so it has spent its one
 * client presence hold already.
 */
export function scheduleDecision(
  active: boolean,
  now: number,
  policy: PushPolicy = DEFAULT_PUSH_POLICY,
): { dueAt: number; deferred: boolean } {
  return {
    dueAt: now + (active ? policy.holdWhileActiveMs : policy.awayDebounceMs),
    deferred: active,
  };
}

/** The rows this flush considers: due now, or due inside the batch slack. */
export function dueRows(
  rows: OutboxRow[],
  now: number,
  policy: PushPolicy = DEFAULT_PUSH_POLICY,
): OutboxRow[] {
  return rows.filter((r) => r.dueAt <= now + policy.batchSlackMs);
}

export interface FlushInput {
  /** Every pending row for one recipient, not only the due ones. */
  rows: OutboxRow[];
  now: number;
  /** The recipient can receive a push at all: enabled, with a live device. */
  canPush: boolean;
  clientActive: boolean;
  machineActive: boolean;
  /** Row ids whose source was read or superseded. These are dropped. */
  canceled?: ReadonlySet<string>;
}

export interface FlushPlan {
  /** Delete these rows and deliver them as one push. */
  send: OutboxRow[];
  /** Delete these rows and send nothing: read, superseded, or undeliverable. */
  drop: OutboxRow[];
  /** Due rows held this round. Patch deferred true and dueAt to nextDueAt. */
  hold: OutboxRow[];
  /** Rows not due yet, moved onto the same deadline. Patch dueAt only. */
  defer: OutboxRow[];
  /** The one deadline every remaining row shares, or null when none was held. */
  nextDueAt: number | null;
  /** Delay for the next flush, or null when this flush emptied the outbox. */
  rescheduleInMs: number | null;
  /** The machine hold hit its ceiling, so the whole batch escalates. */
  capReached: boolean;
}

const EMPTY_PLAN: FlushPlan = {
  send: [],
  drop: [],
  hold: [],
  defer: [],
  nextDueAt: null,
  rescheduleInMs: null,
  capReached: false,
};

/**
 * The whole routing policy in one pure function. Given every pending row and
 * the presence around them, decide what ships, what waits, and what is thrown
 * away.
 *
 * Two subtleties are load bearing. Every held row lands on ONE shared
 * deadline, because due times otherwise drift apart and walking away buzzes
 * the phone once per drifted group instead of once in total. And a machine
 * hold reschedules once per flush, not once per row, so a hold that keeps
 * re-deferring costs one pending wakeup rather than a growing pile.
 */
export function decideFlush(
  input: FlushInput,
  policy: PushPolicy = DEFAULT_PUSH_POLICY,
): FlushPlan {
  const { rows, now, canPush, clientActive, machineActive } = input;
  const due = dueRows(rows, now, policy);
  if (due.length === 0) return { ...EMPTY_PLAN };

  // A machine hold stops once the oldest pending row hits the ceiling, and the
  // whole batch goes together — walking into the ceiling costs one buzz rather
  // than dribbling rows out as each one ages past it.
  const capReached =
    machineActive && due.some((r) => now - r.createdAt >= policy.maxHoldMs);
  const holdForMachine = machineActive && !capReached;

  const send: OutboxRow[] = [];
  const drop: OutboxRow[] = [];
  const hold: OutboxRow[] = [];

  for (const row of due) {
    if (!canPush) {
      drop.push(row);
      continue;
    }
    if (input.canceled?.has(row.id)) {
      drop.push(row);
      continue;
    }
    // Hold when the person is at the computer with machine presence on (the
    // push waits until they walk away), or when they came back to an app
    // surface while this sat in the away debounce (one escalating hold).
    if (holdForMachine || (!row.deferred && clientActive)) {
      hold.push(row);
      continue;
    }
    send.push(row);
  }

  if (hold.length === 0) {
    return {
      send,
      drop,
      hold,
      defer: [],
      nextDueAt: null,
      rescheduleInMs: rows.length > due.length ? nextWakeup(rows, due, now) : null,
      capReached,
    };
  }

  const nextDueAt = now + policy.holdWhileActiveMs;
  const settled = new Set<string>([...send, ...drop, ...hold].map((r) => r.id));
  const defer = rows.filter((r) => !settled.has(r.id) && r.dueAt !== nextDueAt);
  return {
    send,
    drop,
    hold,
    defer,
    nextDueAt,
    rescheduleInMs: policy.holdWhileActiveMs,
    capReached,
  };
}

/** Nothing held, but rows remain that were not due: wake for the earliest. */
function nextWakeup(rows: OutboxRow[], due: OutboxRow[], now: number): number | null {
  const settled = new Set(due.map((r) => r.id));
  const rest = rows.filter((r) => !settled.has(r.id));
  if (rest.length === 0) return null;
  const earliest = Math.min(...rest.map((r) => r.dueAt));
  return Math.max(0, earliest - now);
}
