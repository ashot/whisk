import { describe, expect, test } from "bun:test";
import { parseSince, parseWhen, whenOrThrow } from "./when";

// Wednesday 2026-09-02 10:30 local.
const NOW = new Date(2026, 8, 2, 10, 30).getTime();
const local = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

describe("parseWhen", () => {
  test("durations", () => {
    expect(parseWhen("3h", NOW)).toBe(NOW + 3 * 3_600_000);
    expect(parseWhen("in 45m", NOW)).toBe(NOW + 45 * 60_000);
    expect(parseWhen("2 days", NOW)).toBe(NOW + 2 * 86_400_000);
    expect(parseWhen("1w", NOW)).toBe(NOW + 7 * 86_400_000);
  });
  test("named moments", () => {
    expect(parseWhen("tomorrow", NOW)).toBe(local(2026, 9, 3, 9));
    expect(parseWhen("tonight", NOW)).toBe(local(2026, 9, 2, 18));
    expect(parseWhen("weekend", NOW)).toBe(local(2026, 9, 5, 9));
    expect(parseWhen("next week", NOW)).toBe(local(2026, 9, 7, 9));
  });
  test("weekday with optional time, never today", () => {
    expect(parseWhen("fri", NOW)).toBe(local(2026, 9, 4, 9));
    expect(parseWhen("monday 9am", NOW)).toBe(local(2026, 9, 7, 9));
    expect(parseWhen("wed 14:15", NOW)).toBe(local(2026, 9, 9, 14, 15));
    expect(parseWhen("wed nonsense", NOW)).toBeNull();
  });
  test("clock times roll to tomorrow once passed", () => {
    expect(parseWhen("5pm", NOW)).toBe(local(2026, 9, 2, 17));
    expect(parseWhen("9am", NOW)).toBe(local(2026, 9, 3, 9));
    expect(parseWhen("tomorrow 3pm", NOW)).toBe(local(2026, 9, 3, 15));
  });
  test("iso", () => {
    expect(parseWhen("2026-09-10", NOW)).toBe(local(2026, 9, 10, 9));
    expect(parseWhen("2026-09-10T14:00", NOW)).toBe(local(2026, 9, 10, 14));
  });
  test("garbage and the past throw", () => {
    expect(parseWhen("whenever", NOW)).toBeNull();
    expect(() => whenOrThrow("whenever", NOW)).toThrow(/Cannot read/);
    expect(() => whenOrThrow("2020-01-01", NOW)).toThrow(/past/);
  });
});

describe("parseSince", () => {
  test("durations and dates", () => {
    expect(parseSince("7d", NOW)).toBe(NOW - 7 * 86_400_000);
    expect(parseSince("2026-09-01", NOW)).toBe(new Date("2026-09-01").getTime());
    expect(parseSince("soon", NOW)).toBeNull();
  });
});
