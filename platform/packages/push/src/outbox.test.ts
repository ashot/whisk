// End to end over the hooks, with an in memory outbox standing in for the
// app's table. No network, no framework, no clock of its own.

import { describe, expect, test } from "bun:test";
import {
  enqueuePush,
  flushPush,
  type PushOutboxHooks,
  type PushRecipient,
} from "./outbox";
import {
  AWAY_DEBOUNCE_MS,
  HOLD_WHILE_ACTIVE_MS,
  MAX_HOLD_MS,
  type NewOutboxRow,
  type OutboxRow,
  type PresenceInput,
} from "./policy";
import type { PushMessage } from "./transports/types";

const NOW = 1_700_000_000_000;

interface Harness {
  hooks: PushOutboxHooks;
  rows: OutboxRow[];
  delivered: Array<{ message: PushMessage; rows: OutboxRow[] }>;
  scheduled: Array<{ userId: string; delayMs: number }>;
  read: Set<string>;
  presence: PresenceInput;
  clock: { now: number };
}

function harness(
  init: {
    recipient?: PushRecipient | null;
    presence?: PresenceInput;
    now?: number;
  } = {},
): Harness {
  const clock = { now: init.now ?? NOW };
  const rows: OutboxRow[] = [];
  const delivered: Harness["delivered"] = [];
  const scheduled: Harness["scheduled"] = [];
  const read = new Set<string>();
  const state = {
    presence: init.presence ?? {},
  };
  const recipient =
    init.recipient === undefined
      ? ({ id: "u1", devices: [{ token: "ExponentPushToken[a]" }] } as PushRecipient)
      : init.recipient;
  let nextId = 1;

  const hooks: PushOutboxHooks = {
    async recipient() {
      return recipient;
    },
    async presence() {
      return state.presence;
    },
    async pending(userId) {
      return rows.filter((r) => r.userId === userId);
    },
    async insert(row: NewOutboxRow) {
      rows.push({ ...row, id: `r${nextId++}` });
    },
    async patch(rowId, patch) {
      const row = rows.find((r) => r.id === rowId);
      if (!row) throw new Error(`patched a row that is gone: ${rowId}`);
      Object.assign(row, patch);
    },
    async remove(rowId) {
      const i = rows.findIndex((r) => r.id === rowId);
      if (i < 0) throw new Error(`removed a row that is gone: ${rowId}`);
      rows.splice(i, 1);
    },
    async canceled(candidates) {
      return candidates.filter((r) => r.sourceId && read.has(r.sourceId)).map((r) => r.id);
    },
    async schedule(userId, delayMs) {
      scheduled.push({ userId, delayMs });
    },
    async deliver(_recipient, message, sent) {
      delivered.push({ message, rows: sent });
    },
    now: () => clock.now,
  };

  const h: Harness = {
    hooks,
    rows,
    delivered,
    scheduled,
    read,
    get presence() {
      return state.presence;
    },
    set presence(next: PresenceInput) {
      state.presence = next;
    },
    clock,
  };
  return h;
}

const away: PresenceInput = { client: null };
const atDesk: PresenceInput = {
  client: { lastSeen: NOW, lastInputAt: NOW },
};

function queue(h: Harness, over: Partial<Parameters<typeof enqueuePush>[1]> = {}) {
  return enqueuePush(h.hooks, {
    userId: "u1",
    title: "Session waiting",
    body: "It needs input",
    ...over,
  });
}

describe("enqueuePush", () => {
  test("an away recipient is staged on the short debounce", async () => {
    const h = harness({ presence: away });
    const result = await queue(h);
    expect(result).toMatchObject({ queued: true, dueAt: NOW + AWAY_DEBOUNCE_MS });
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0].deferred).toBe(false);
    expect(h.scheduled).toEqual([{ userId: "u1", delayMs: AWAY_DEBOUNCE_MS }]);
  });

  test("a recipient at their desk buys the hold window up front", async () => {
    const h = harness({ presence: atDesk });
    const result = await queue(h);
    expect(result.dueAt).toBe(NOW + HOLD_WHILE_ACTIVE_MS);
    expect(h.rows[0].deferred).toBe(true);
  });

  test("push switched off stages nothing", async () => {
    const h = harness({
      recipient: { id: "u1", enabled: false, devices: [{ token: "t" }] },
    });
    expect(await queue(h)).toEqual({ queued: false, reason: "disabled" });
    expect(h.rows).toEqual([]);
    expect(h.scheduled).toEqual([]);
  });

  test("a recipient with no device stages nothing", async () => {
    const h = harness({ recipient: { id: "u1", devices: [] } });
    expect(await queue(h)).toEqual({ queued: false, reason: "no-device" });
  });

  test("an unknown recipient stages nothing", async () => {
    const h = harness({ recipient: null });
    expect(await queue(h)).toEqual({ queued: false, reason: "no-recipient" });
  });
});

describe("flushPush", () => {
  test("holds the push while the desktop is in use, then sends it", async () => {
    const h = harness({ presence: away });
    await queue(h);

    // The person sits down before the debounce elapses.
    h.presence = atDesk;
    h.clock.now = NOW + AWAY_DEBOUNCE_MS;
    const held = await flushPush(h.hooks, "u1");
    expect(held).toMatchObject({ sent: 0, held: 1, dropped: 0 });
    expect(h.delivered).toEqual([]);
    expect(h.rows[0].deferred).toBe(true);
    expect(h.rows[0].dueAt).toBe(h.clock.now + HOLD_WHILE_ACTIVE_MS);
    expect(h.scheduled.at(-1)).toEqual({ userId: "u1", delayMs: HOLD_WHILE_ACTIVE_MS });

    // Still at the desk, but the item was never opened: escalate to the phone.
    h.clock.now += HOLD_WHILE_ACTIVE_MS;
    h.presence = { client: { lastSeen: h.clock.now, lastInputAt: h.clock.now } };
    const sent = await flushPush(h.hooks, "u1");
    expect(sent.sent).toBe(1);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].message.title).toBe("Session waiting");
    expect(h.rows).toEqual([]);
  });

  test("machine presence keeps holding, and the ceiling ends the wait", async () => {
    const h = harness({
      presence: {
        client: { lastSeen: NOW, lastInputAt: NOW - 30 * 60_000 },
        machines: [{ lastSeen: NOW, lastInputAt: NOW }],
      },
    });
    await queue(h);

    for (let i = 0; i < 3; i++) {
      h.clock.now += HOLD_WHILE_ACTIVE_MS;
      h.presence = {
        client: { lastSeen: h.clock.now, lastInputAt: h.clock.now - 30 * 60_000 },
        machines: [{ lastSeen: h.clock.now, lastInputAt: h.clock.now }],
      };
      const flush = await flushPush(h.hooks, "u1");
      expect(flush).toMatchObject({ sent: 0, held: 1, capReached: false });
    }
    expect(h.delivered).toEqual([]);

    h.clock.now = NOW + MAX_HOLD_MS;
    h.presence = {
      client: { lastSeen: h.clock.now, lastInputAt: h.clock.now - 30 * 60_000 },
      machines: [{ lastSeen: h.clock.now, lastInputAt: h.clock.now }],
    };
    const escalated = await flushPush(h.hooks, "u1");
    expect(escalated).toMatchObject({ sent: 1, capReached: true });
    expect(h.delivered).toHaveLength(1);
  });

  test("a burst of twelve becomes one push", async () => {
    const h = harness({ presence: away });
    for (let i = 0; i < 12; i++) {
      h.clock.now = NOW + i * 500;
      await queue(h, { type: "session_idle", title: `Session ${i}` });
    }
    expect(h.rows).toHaveLength(12);

    h.clock.now = NOW + AWAY_DEBOUNCE_MS;
    const flush = await flushPush(h.hooks, "u1");
    expect(flush.sent).toBe(12);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].message.title).toBe("12 notifications");
    expect(h.rows).toEqual([]);
  });

  test("reading the item cancels its push", async () => {
    const h = harness({ presence: away });
    await queue(h, { sourceId: "n1", title: "One" });
    await queue(h, { sourceId: "n2", title: "Two" });

    h.read.add("n1");
    h.clock.now = NOW + AWAY_DEBOUNCE_MS;
    const flush = await flushPush(h.hooks, "u1");
    expect(flush).toMatchObject({ sent: 1, dropped: 1 });
    expect(h.delivered[0].message.title).toBe("Two");
    expect(h.rows).toEqual([]);
  });

  test("reading everything sends nothing at all", async () => {
    const h = harness({ presence: away });
    await queue(h, { sourceId: "n1" });
    await queue(h, { sourceId: "n2" });
    h.read.add("n1");
    h.read.add("n2");

    h.clock.now = NOW + AWAY_DEBOUNCE_MS;
    const flush = await flushPush(h.hooks, "u1");
    expect(flush).toMatchObject({ sent: 0, dropped: 2 });
    expect(h.delivered).toEqual([]);
    expect(h.rows).toEqual([]);
  });

  test("a flush before anything is due changes nothing", async () => {
    const h = harness({ presence: atDesk });
    await queue(h);
    const before = h.scheduled.length;
    const flush = await flushPush(h.hooks, "u1");
    expect(flush).toEqual({ sent: 0, dropped: 0, held: 0, capReached: false });
    expect(h.rows).toHaveLength(1);
    expect(h.scheduled).toHaveLength(before);
  });

  test("push switched off after staging clears the outbox instead of sending", async () => {
    const h = harness({ presence: away });
    await queue(h);
    const off = harness({ recipient: { id: "u1", enabled: false, devices: [] } });
    // Reuse the staged row against a recipient who can no longer be reached.
    off.rows.push(...h.rows);
    off.clock.now = NOW + AWAY_DEBOUNCE_MS;
    const flush = await flushPush(off.hooks, "u1");
    expect(flush).toMatchObject({ sent: 0, dropped: 1 });
    expect(off.delivered).toEqual([]);
    expect(off.rows).toEqual([]);
  });

  test("rows queued minutes apart collapse onto one deadline", async () => {
    // One row staged while the person was at their desk, another after they
    // stepped away. Their deadlines are two minutes apart.
    const h = harness({ presence: atDesk });
    await queue(h, { title: "First" });
    h.clock.now = NOW + 30_000;
    h.presence = away;
    await queue(h, { title: "Second" });
    expect(new Set(h.rows.map((r) => r.dueAt)).size).toBe(2);

    // They come back, and the second row's flush finds them at the desk.
    h.clock.now = NOW + 30_000 + AWAY_DEBOUNCE_MS;
    h.presence = { client: { lastSeen: h.clock.now, lastInputAt: h.clock.now } };
    const held = await flushPush(h.hooks, "u1");
    expect(held).toMatchObject({ sent: 0, held: 1 });
    expect(new Set(h.rows.map((r) => r.dueAt))).toEqual(
      new Set([h.clock.now + HOLD_WHILE_ACTIVE_MS]),
    );

    // Walking away then costs one buzz, not one per deadline.
    h.clock.now += HOLD_WHILE_ACTIVE_MS;
    h.presence = away;
    const flush = await flushPush(h.hooks, "u1");
    expect(flush.sent).toBe(2);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].message.title).toBe("2 notifications");
  });

  test("the app's labels shape the digest, and its taxonomy stays its own", async () => {
    const h = harness({ presence: away });
    await queue(h, { type: "permission_request", title: "Allow write?" });
    await queue(h, { type: "permission_request", title: "Allow read?" });
    h.clock.now = NOW + AWAY_DEBOUNCE_MS;
    await flushPush(h.hooks, "u1", {
      digest: {
        labels: { permission_request: ["permission request", "permission requests"] },
      },
    });
    expect(h.delivered[0].message.body).toBe("2 permission requests");
  });
});
