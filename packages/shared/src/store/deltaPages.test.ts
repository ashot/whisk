import { describe, expect, test } from "bun:test";
import { drainDeltaPages, type DeltaPagePayload } from "./deltaPages";

type Row = { _id: string; updated_at: number };

const page = (
  rows: Row[],
  nextSince: number,
  hasMore: boolean,
): DeltaPagePayload<Row> => ({ rows, nextSince, hasMore });

const row = (_id: string, updated_at: number): Row => ({ _id, updated_at });

describe("drainDeltaPages", () => {
  test("a drained page applies its rows and fetches nothing", async () => {
    const applied: Row[] = [];
    let fetches = 0;
    const final = await drainDeltaPages(
      page([row("a", 10)], 10, false),
      async () => {
        fetches++;
        return page([], 10, false);
      },
      (rows) => applied.push(...rows),
    );
    expect(applied.map((r) => r._id)).toEqual(["a"]);
    expect(fetches).toBe(0);
    expect(final).toBe(10);
  });

  test("the first page lands synchronously, before any await", () => {
    const applied: Row[] = [];
    void drainDeltaPages(
      page([row("a", 10)], 10, false),
      async () => page([], 10, false),
      (rows) => applied.push(...rows),
    );
    expect(applied).toHaveLength(1);
  });

  test("follows nextSince — never a row's own stamp — while hasMore", async () => {
    // The server trimmed the first page back to ts 10 even though it carries a
    // row stamped 20; a client resuming from the last row would skip "b2".
    const pages: Record<number, DeltaPagePayload<Row>> = {
      10: page([row("b1", 20), row("b2", 20)], 20, true),
      20: page([row("c", 30)], 30, false),
    };
    const asked: number[] = [];
    const applied: Row[] = [];
    const final = await drainDeltaPages(
      page([row("a", 10)], 10, true),
      async (since) => {
        asked.push(since);
        return pages[since]!;
      },
      (rows) => applied.push(...rows),
    );
    expect(asked).toEqual([10, 20]);
    expect(applied.map((r) => r._id)).toEqual(["a", "b1", "b2", "c"]);
    expect(final).toBe(30);
  });

  test("a page claiming more without advancing ends the loop", async () => {
    let fetches = 0;
    const final = await drainDeltaPages(
      page([], 10, true),
      async () => {
        fetches++;
        return page([row("x", 10)], 10, true);
      },
      () => {},
    );
    expect(fetches).toBe(1);
    expect(final).toBe(10);
  });
});
