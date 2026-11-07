// The outbox driver: two thin functions the app wraps in its own mutations.
//
//   enqueuePush  called from the same write that created the item. Reads
//                presence, stages a row, and asks for a flush later.
//   flushPush    called by the scheduler. Loads the pending rows, applies
//                decideFlush, writes the result, and delivers one push.
//
// Every read and write is a hook the app supplies, so this file names no
// table, no id type, and no framework. The app keeps its schema and its event
// taxonomy; the library keeps the policy.

import {
  DEFAULT_PUSH_POLICY,
  decideFlush,
  dueRows,
  resolvePresence,
  scheduleDecision,
  type NewOutboxRow,
  type OutboxPatch,
  type OutboxRow,
  type Presence,
  type PresenceInput,
  type PushPolicy,
} from "./policy";
import { buildDigest, type DigestOptions } from "./digest";
import type { PushMessage, PushTarget } from "./transports/types";

/** One person, as the outbox needs them. The app maps its own user row. */
export interface PushRecipient {
  id: string;
  /** The master switch. Absent reads as ON. */
  enabled?: boolean;
  /** Widen presence to the person's own machines. Absent reads as ON. */
  machineWidePresence?: boolean;
  /** Where to deliver. No devices means nothing to send. */
  devices: PushTarget[];
}

/** What the app asks to be pushed. Staging, not sending. */
export interface EnqueueRequest {
  userId: string;
  type?: string;
  title: string;
  subtitle?: string;
  body: string;
  data?: unknown;
  /** The item this push is about, so reading it cancels the push. */
  sourceId?: string;
}

export interface PushOutboxHooks {
  /** Load the person. Null skips: deleted, or no way to reach them. */
  recipient(userId: string): Promise<PushRecipient | null>;
  /** Load the presence signals. Return an empty object for "no idea". */
  presence(userId: string): Promise<PresenceInput>;
  /** Every pending row for this person, due or not. */
  pending(userId: string): Promise<OutboxRow[]>;
  insert(row: NewOutboxRow): Promise<void>;
  patch(rowId: string, patch: OutboxPatch): Promise<void>;
  remove(rowId: string): Promise<void>;
  /**
   * Which of these rows no longer need a push: the source was read, or it was
   * superseded. Return their row ids. This is the cancel on read seam; an app
   * with no readable source can leave it out.
   */
  canceled?(rows: OutboxRow[]): Promise<Iterable<string>>;
  /** Ask for another flush of this person's outbox in delayMs. */
  schedule(userId: string, delayMs: number): Promise<void>;
  /**
   * Deliver the finished message. The app adds whatever its taxonomy decides
   * here — badge count, Android channel, iOS interruption level — then hands
   * it to a transport or router.
   */
  deliver(
    recipient: PushRecipient,
    message: PushMessage,
    rows: OutboxRow[],
  ): Promise<void>;
  /** Injectable clock. Defaults to Date.now. */
  now?(): number;
}

export interface PushOutboxConfig {
  policy?: PushPolicy;
  /** Label table and headline for the digest fallback. */
  digest?: DigestOptions;
}

export interface EnqueueResult {
  queued: boolean;
  reason: "queued" | "disabled" | "no-device" | "no-recipient";
  dueAt?: number;
  presence?: Presence;
}

/**
 * Stage one push. Call it from the same write that created the item, in place
 * of sending immediately. An active device buys the hold window; anyone away
 * gets the debounce that lets the next few rows join this one.
 */
export async function enqueuePush(
  hooks: PushOutboxHooks,
  request: EnqueueRequest,
  config: PushOutboxConfig = {},
): Promise<EnqueueResult> {
  const policy = config.policy ?? DEFAULT_PUSH_POLICY;
  const now = (hooks.now ?? Date.now)();

  const recipient = await hooks.recipient(request.userId);
  if (!recipient) return { queued: false, reason: "no-recipient" };
  if (recipient.enabled === false) return { queued: false, reason: "disabled" };
  if (recipient.devices.length === 0) return { queued: false, reason: "no-device" };

  const presence = resolvePresence(
    {
      ...(await hooks.presence(request.userId)),
      machineWidePresence: recipient.machineWidePresence,
    },
    now,
    policy,
  );
  const { dueAt, deferred } = scheduleDecision(presence.active, now, policy);

  await hooks.insert({
    userId: request.userId,
    ...(request.sourceId !== undefined ? { sourceId: request.sourceId } : {}),
    ...(request.type !== undefined ? { type: request.type } : {}),
    title: request.title,
    ...(request.subtitle !== undefined ? { subtitle: request.subtitle } : {}),
    body: request.body,
    ...(request.data !== undefined ? { data: request.data } : {}),
    createdAt: now,
    dueAt,
    deferred,
  });
  await hooks.schedule(request.userId, dueAt - now);
  return { queued: true, reason: "queued", dueAt, presence };
}

export interface FlushResult {
  /** Rows delivered as one push. Zero means nothing shipped this round. */
  sent: number;
  /** Rows deleted without a push: read, superseded, or undeliverable. */
  dropped: number;
  /** Rows still waiting, held for a device that is in use. */
  held: number;
  /** The hold hit its ceiling and the batch escalated anyway. */
  capReached: boolean;
  /** The message that went out, for tests and logs. */
  message?: PushMessage;
}

/**
 * One flush. Everything due ships as a single push, everything read is thrown
 * away, and everything held lands on one shared deadline so walking away costs
 * one buzz rather than one per group.
 */
export async function flushPush(
  hooks: PushOutboxHooks,
  userId: string,
  config: PushOutboxConfig = {},
): Promise<FlushResult> {
  const policy = config.policy ?? DEFAULT_PUSH_POLICY;
  const now = (hooks.now ?? Date.now)();

  const rows = await hooks.pending(userId);
  const due = dueRows(rows, now, policy);
  if (due.length === 0) {
    return { sent: 0, dropped: 0, held: 0, capReached: false };
  }

  const recipient = await hooks.recipient(userId);
  const canPush =
    !!recipient && recipient.enabled !== false && recipient.devices.length > 0;

  const presence = canPush
    ? resolvePresence(
        {
          ...(await hooks.presence(userId)),
          machineWidePresence: recipient!.machineWidePresence,
        },
        now,
        policy,
      )
    : { clientActive: false, clientAlive: false, machineActive: false, active: false };

  // Ask about cancellation only for the rows this flush could actually send.
  const cancelable = due.filter((r) => r.sourceId !== undefined);
  const canceled =
    canPush && hooks.canceled && cancelable.length > 0
      ? new Set(await hooks.canceled(cancelable))
      : undefined;

  const plan = decideFlush(
    {
      rows,
      now,
      canPush,
      clientActive: presence.clientActive,
      machineActive: presence.machineActive,
      ...(canceled ? { canceled } : {}),
    },
    policy,
  );

  for (const row of plan.drop) await hooks.remove(row.id);
  for (const row of plan.hold) {
    await hooks.patch(row.id, { deferred: true, dueAt: plan.nextDueAt! });
  }
  for (const row of plan.defer) {
    await hooks.patch(row.id, { dueAt: plan.nextDueAt! });
  }
  // One reschedule per flush, never one per row: a flush already handles every
  // due row, so per row scheduling only spawns wakeups that find nothing.
  if (plan.rescheduleInMs !== null) {
    await hooks.schedule(userId, plan.rescheduleInMs);
  }

  const result: FlushResult = {
    sent: 0,
    dropped: plan.drop.length,
    held: plan.hold.length,
    capReached: plan.capReached,
  };
  if (plan.send.length === 0) return result;

  const message = buildDigest(plan.send, config.digest);
  // Delete before delivering: a row that reached a transport must never ship
  // twice, and a failed send costs one push rather than a stuck outbox.
  for (const row of plan.send) await hooks.remove(row.id);
  await hooks.deliver(recipient!, message, plan.send);

  result.sent = plan.send.length;
  result.message = message;
  return result;
}
