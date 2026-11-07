import { expect, test } from "bun:test";
import { subscribeDeltaPages } from "./liveDeltaPages";
import type { DeltaPagePayload } from "./deltaPages";

function harness() {
  const subscriptions: Array<{
    since: number;
    update: (page: DeltaPagePayload<string>) => void;
    fail: () => void;
    stopped: boolean;
  }> = [];
  const rows: string[] = [];
  let ready = 0;
  let errors = 0;
  const stop = subscribeDeltaPages<string>(
    (since, update, fail) => {
      const sub = { since, update, fail, stopped: false };
      subscriptions.push(sub);
      return () => {
        sub.stopped = true;
      };
    },
    (page) => rows.push(...page),
    () => ready++,
    () => errors++,
  );
  const page = (
    index: number,
    nextSince: number,
    hasMore: boolean,
    ...rows: string[]
  ) => subscriptions[index].update({ rows, nextSince, hasMore });
  return { subscriptions, rows, stop, page, state: () => ({ ready, errors }) };
}

test("keeps the live tail subscribed after a paginated initial sync", () => {
  const h = harness();
  h.page(0, 1999, true, "first");
  h.page(1, 2100, false, "tail");
  expect(h.subscriptions.map((s) => s.since)).toEqual([0, 1999]);
  h.page(1, 2101, false, "new event", "cancelled event");
  expect(h.rows).toEqual(["first", "tail", "new event", "cancelled event"]);
  expect(h.state()).toEqual({ ready: 2, errors: 0 });
});

test("fences old pages when their live boundary changes", () => {
  const h = harness();
  h.page(0, 10, true, "a");
  h.page(1, 20, true, "b");
  h.page(2, 30, false, "c");
  h.page(0, 12, true, "updated a");
  expect(h.subscriptions[1].stopped).toBe(true);
  expect(h.subscriptions[2].stopped).toBe(true);
  h.page(1, 999, false, "stale");
  h.subscriptions[2].fail();
  h.page(3, 30, false, "fresh tail");
  expect(h.rows).not.toContain("stale");
  expect(h.state()).toEqual({ ready: 2, errors: 0 });
});

test("unchanged boundaries reuse subscriptions and shortened results retire tails", () => {
  const h = harness();
  h.page(0, 10, true, "a");
  h.page(0, 10, true, "edited a");
  expect(h.subscriptions).toHaveLength(2);
  h.page(0, 8, false, "short result");
  expect(h.subscriptions[1].stopped).toBe(true);
  expect(h.state().ready).toBe(1);
});

test("fails on stalled watermarks and recovers without claiming partial readiness", () => {
  const h = harness();
  h.page(0, 10, true, "a");
  h.page(1, 10, true, "b");
  expect(h.state()).toEqual({ ready: 0, errors: 1 });
  h.page(1, 11, false, "recovered");
  expect(h.state().ready).toBe(1);
  h.subscriptions[0].fail();
  expect(h.subscriptions[1].stopped).toBe(true);
});

test("cleanup ignores late pages and errors", () => {
  const h = harness();
  h.page(0, 10, true, "a");
  h.stop();
  h.page(1, 11, false, "late");
  h.subscriptions[0].fail();
  expect(h.rows).toEqual(["a"]);
  expect(h.subscriptions.every((s) => s.stopped)).toBe(true);
  expect(h.state()).toEqual({ ready: 0, errors: 0 });
});
