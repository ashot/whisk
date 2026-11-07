import { describe, expect, test } from "bun:test";
import {
  AWAY_DEBOUNCE_MS,
  BATCH_SLACK_MS,
  DEFAULT_PUSH_POLICY,
  HOLD_WHILE_ACTIVE_MS,
  MAX_HOLD_MS,
  PRESENCE_FRESH_MS,
  decideFlush,
  dueRows,
  isClientActive,
  isMachineActive,
  resolvePresence,
  scheduleDecision,
  type OutboxRow,
} from "./policy";
import { buildDigest } from "./digest";

const NOW = 1_700_000_000_000;

function row(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: over.id ?? "r1",
    userId: "u1",
    createdAt: NOW - 1000,
    dueAt: NOW,
    deferred: false,
    title: "Session waiting",
    body: "It needs input",
    ...over,
  };
}

describe("presence", () => {
  test("a fresh heartbeat with fresh input is active", () => {
    expect(isClientActive({ lastSeen: NOW - 1000, lastInputAt: NOW - 1000 }, NOW)).toBe(
      true,
    );
  });

  test("a focused but abandoned window is not active", () => {
    expect(
      isClientActive({ lastSeen: NOW - 1000, lastInputAt: NOW - 10 * 60_000 }, NOW),
    ).toBe(false);
  });

  test("a stale heartbeat is not active", () => {
    expect(
      isClientActive({ lastSeen: NOW - PRESENCE_FRESH_MS - 1, lastInputAt: NOW }, NOW),
    ).toBe(false);
  });

  test("no presence row at all reads as away", () => {
    expect(isClientActive(null, NOW)).toBe(false);
    expect(isClientActive(undefined, NOW)).toBe(false);
  });

  test("a machine that reports no input contributes nothing", () => {
    expect(isMachineActive([{ lastSeen: NOW }], NOW)).toBe(false);
  });

  test("a remote machine is never where the person sits", () => {
    expect(
      isMachineActive([{ lastSeen: NOW, lastInputAt: NOW, isRemote: true }], NOW),
    ).toBe(false);
  });

  test("machine presence needs a live app surface to hold behind", () => {
    const machines = [{ lastSeen: NOW, lastInputAt: NOW }];
    const withApp = resolvePresence(
      { client: { lastSeen: NOW - 1000, lastInputAt: NOW - 10 * 60_000 }, machines },
      NOW,
    );
    expect(withApp.machineActive).toBe(true);
    expect(withApp.clientActive).toBe(false);
    expect(withApp.active).toBe(true);

    const appClosed = resolvePresence({ client: null, machines }, NOW);
    expect(appClosed.machineActive).toBe(false);
    expect(appClosed.active).toBe(false);
  });

  test("opting out of machine presence skips the wider signal", () => {
    const presence = resolvePresence(
      {
        client: { lastSeen: NOW, lastInputAt: NOW - 10 * 60_000 },
        machines: [{ lastSeen: NOW, lastInputAt: NOW }],
        machineWidePresence: false,
      },
      NOW,
    );
    expect(presence.machineActive).toBe(false);
    expect(presence.active).toBe(false);
  });
});

describe("scheduleDecision", () => {
  test("an active device buys the hold window and spends the one deferral", () => {
    expect(scheduleDecision(true, NOW)).toEqual({
      dueAt: NOW + HOLD_WHILE_ACTIVE_MS,
      deferred: true,
    });
  });

  test("away gets the short debounce that collapses a burst", () => {
    expect(scheduleDecision(false, NOW)).toEqual({
      dueAt: NOW + AWAY_DEBOUNCE_MS,
      deferred: false,
    });
  });
});

describe("dueRows", () => {
  test("rows landing inside the batch slack ride this flush", () => {
    const rows = [
      row({ id: "now", dueAt: NOW }),
      row({ id: "soon", dueAt: NOW + BATCH_SLACK_MS - 1 }),
      row({ id: "later", dueAt: NOW + BATCH_SLACK_MS + 1 }),
    ];
    expect(dueRows(rows, NOW).map((r) => r.id)).toEqual(["now", "soon"]);
  });
});

describe("decideFlush: hold while a device is active", () => {
  test("an undeferred row is held when an app surface is in use", () => {
    const plan = decideFlush({
      rows: [row()],
      now: NOW,
      canPush: true,
      clientActive: true,
      machineActive: false,
    });
    expect(plan.send).toEqual([]);
    expect(plan.hold.map((r) => r.id)).toEqual(["r1"]);
    expect(plan.nextDueAt).toBe(NOW + HOLD_WHILE_ACTIVE_MS);
    expect(plan.rescheduleInMs).toBe(HOLD_WHILE_ACTIVE_MS);
  });

  test("client presence holds once, then escalates to the phone", () => {
    const plan = decideFlush({
      rows: [row({ deferred: true })],
      now: NOW,
      canPush: true,
      clientActive: true,
      machineActive: false,
    });
    expect(plan.send.map((r) => r.id)).toEqual(["r1"]);
    expect(plan.hold).toEqual([]);
    expect(plan.rescheduleInMs).toBe(null);
  });

  test("machine presence keeps holding past the one deferral", () => {
    const plan = decideFlush({
      rows: [row({ deferred: true })],
      now: NOW,
      canPush: true,
      clientActive: false,
      machineActive: true,
    });
    expect(plan.send).toEqual([]);
    expect(plan.hold.map((r) => r.id)).toEqual(["r1"]);
    expect(plan.capReached).toBe(false);
  });

  test("the machine hold has a ceiling, and the whole batch escalates at once", () => {
    const plan = decideFlush({
      rows: [
        row({ id: "old", deferred: true, createdAt: NOW - MAX_HOLD_MS }),
        row({ id: "young", deferred: true, createdAt: NOW - 1000 }),
      ],
      now: NOW,
      canPush: true,
      clientActive: false,
      machineActive: true,
    });
    expect(plan.capReached).toBe(true);
    expect(plan.send.map((r) => r.id)).toEqual(["old", "young"]);
    expect(plan.hold).toEqual([]);
  });

  test("held rows land on one shared deadline, including rows not yet due", () => {
    const plan = decideFlush({
      rows: [
        row({ id: "due", dueAt: NOW }),
        row({ id: "drifted", dueAt: NOW + 10 * 60_000 }),
      ],
      now: NOW,
      canPush: true,
      clientActive: true,
      machineActive: false,
    });
    expect(plan.hold.map((r) => r.id)).toEqual(["due"]);
    expect(plan.defer.map((r) => r.id)).toEqual(["drifted"]);
    expect(plan.nextDueAt).toBe(NOW + HOLD_WHILE_ACTIVE_MS);
  });

  test("one reschedule per flush, however many rows were held", () => {
    const plan = decideFlush({
      rows: [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })],
      now: NOW,
      canPush: true,
      clientActive: true,
      machineActive: false,
    });
    expect(plan.hold).toHaveLength(3);
    expect(plan.rescheduleInMs).toBe(HOLD_WHILE_ACTIVE_MS);
  });
});

describe("decideFlush: cancel and drop", () => {
  test("a row whose source was read is dropped, not sent", () => {
    const plan = decideFlush({
      rows: [row({ id: "read", sourceId: "n1" }), row({ id: "unread", sourceId: "n2" })],
      now: NOW,
      canPush: true,
      clientActive: false,
      machineActive: false,
      canceled: new Set(["read"]),
    });
    expect(plan.drop.map((r) => r.id)).toEqual(["read"]);
    expect(plan.send.map((r) => r.id)).toEqual(["unread"]);
  });

  test("a recipient who cannot receive anything has their rows cleared", () => {
    const plan = decideFlush({
      rows: [row({ id: "a" }), row({ id: "b" })],
      now: NOW,
      canPush: false,
      clientActive: false,
      machineActive: false,
    });
    expect(plan.send).toEqual([]);
    expect(plan.drop.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("nothing due means no plan at all", () => {
    const plan = decideFlush({
      rows: [row({ dueAt: NOW + 10 * 60_000 })],
      now: NOW,
      canPush: true,
      clientActive: false,
      machineActive: false,
    });
    expect(plan).toEqual({
      send: [],
      drop: [],
      hold: [],
      defer: [],
      nextDueAt: null,
      rescheduleInMs: null,
      capReached: false,
    });
  });

  test("a send leaves a wakeup for the rows that were not due", () => {
    const plan = decideFlush({
      rows: [row({ id: "due" }), row({ id: "later", dueAt: NOW + 60_000 })],
      now: NOW,
      canPush: true,
      clientActive: false,
      machineActive: false,
    });
    expect(plan.send.map((r) => r.id)).toEqual(["due"]);
    expect(plan.rescheduleInMs).toBe(60_000);
  });
});

describe("decideFlush: burst collapse", () => {
  test("everything due for one person ships as one send", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ id: `r${i}`, dueAt: NOW - i * 100 }),
    );
    const plan = decideFlush({
      rows,
      now: NOW,
      canPush: true,
      clientActive: false,
      machineActive: false,
    });
    expect(plan.send).toHaveLength(12);
    expect(plan.hold).toEqual([]);
    expect(plan.drop).toEqual([]);
  });
});

describe("digest fallback", () => {
  const labels = {
    session_idle: ["session waiting for input", "sessions waiting for input"],
    permission_request: ["permission request", "permission requests"],
  } as const;

  test("one row keeps its own words and its subtitle", () => {
    const message = buildDigest([
      row({ title: "Deploy failed", subtitle: "#releases", body: "on main", data: { a: 1 } }),
    ]);
    expect(message).toEqual({
      title: "Deploy failed",
      subtitle: "#releases",
      body: "on main",
      data: { a: 1 },
    });
  });

  test("a collapsed burst becomes counts, and drops the subtitle a batch cannot have", () => {
    const message = buildDigest(
      [
        row({ id: "a", type: "session_idle", subtitle: "#one" }),
        row({ id: "b", type: "session_idle", subtitle: "#two" }),
        row({ id: "c", type: "permission_request" }),
      ],
      { labels },
    );
    expect(message.title).toBe("3 notifications");
    expect(message.body).toBe("2 sessions waiting for input · 1 permission request");
    expect(message.subtitle).toBeUndefined();
    expect(message.data).toEqual({ type: "aggregate", count: 3 });
  });

  test("types with no label fall into the generic count", () => {
    const message = buildDigest(
      [
        row({ id: "a", type: "session_idle" }),
        row({ id: "b", type: "doc_commented" }),
        row({ id: "c" }),
      ],
      { labels },
    );
    expect(message.body).toBe("1 session waiting for input · 2 updates");
  });

  test("the headline and the payload are the app's to override", () => {
    const message = buildDigest([row({ id: "a" }), row({ id: "b" })], {
      title: (n) => `${n} things happened`,
      data: (rows) => ({ ids: rows.map((r) => r.id) }),
      separator: ", ",
    });
    expect(message.title).toBe("2 things happened");
    expect(message.data).toEqual({ ids: ["a", "b"] });
  });

  test("an empty batch is a caller bug, not a silent empty push", () => {
    expect(() => buildDigest([])).toThrow();
  });
});

describe("policy is configurable", () => {
  test("the shipped defaults match the exported constants", () => {
    expect(DEFAULT_PUSH_POLICY).toEqual({
      presenceFreshMs: PRESENCE_FRESH_MS,
      inputActiveMs: 3 * 60_000,
      holdWhileActiveMs: HOLD_WHILE_ACTIVE_MS,
      awayDebounceMs: AWAY_DEBOUNCE_MS,
      batchSlackMs: BATCH_SLACK_MS,
      maxHoldMs: MAX_HOLD_MS,
    });
  });

  test("an app can shorten every window", () => {
    const fast = { ...DEFAULT_PUSH_POLICY, holdWhileActiveMs: 1000, awayDebounceMs: 50 };
    expect(scheduleDecision(true, NOW, fast).dueAt).toBe(NOW + 1000);
    expect(scheduleDecision(false, NOW, fast).dueAt).toBe(NOW + 50);
  });
});
