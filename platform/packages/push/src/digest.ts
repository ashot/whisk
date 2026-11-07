// The digest fallback: what a collapsed burst says.
//
// One row keeps its own words, including the subtitle that names where it came
// from. Two or more rows have no single "where", so they become a counted
// summary grouped by the app's event names — "12 notifications", "3 permission
// requests · 9 sessions waiting for input".
//
// The label table is the app's, injected. The library counts and joins; it
// never learns what a permission request is.

import type { OutboxRow } from "./policy";
import type { PushMessage } from "./transports/types";

/** Event name to [singular, plural]. The app's taxonomy, injected. */
export type TypeLabels = Record<string, readonly [string, string]>;

export interface DigestOptions {
  labels?: TypeLabels;
  /** Label for rows whose type has no entry. Default update / updates. */
  otherLabel?: readonly [string, string];
  /** Headline for a multi row digest. Default "N notifications". */
  title?: (count: number) => string;
  /** Joins the counted parts. Default a middle dot. */
  separator?: string;
  /**
   * The payload a digest carries. Default names no single item on purpose:
   * tapping a summary should open the app, not one arbitrary item out of many.
   */
  data?: (rows: OutboxRow[]) => unknown;
}

const DEFAULT_OTHER: readonly [string, string] = ["update", "updates"];

/** Rows summarized as one message. Never mutates or reorders the input. */
export function buildDigest(
  rows: OutboxRow[],
  options: DigestOptions = {},
): PushMessage {
  if (rows.length === 0) {
    throw new Error("buildDigest needs at least one row");
  }
  if (rows.length === 1) {
    const row = rows[0];
    return {
      title: row.title,
      ...(row.subtitle ? { subtitle: row.subtitle } : {}),
      body: row.body,
      data: row.data ?? {},
    };
  }

  const labels = options.labels ?? {};
  const other = options.otherLabel ?? DEFAULT_OTHER;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.type && labels[row.type] ? row.type : "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const [key, n] of counts) {
    if (key === "") continue;
    const [one, many] = labels[key];
    parts.push(`${n} ${n === 1 ? one : many}`);
  }
  const otherCount = counts.get("") ?? 0;
  if (otherCount > 0) {
    parts.push(`${otherCount} ${otherCount === 1 ? other[0] : other[1]}`);
  }

  const title = options.title
    ? options.title(rows.length)
    : `${rows.length} notifications`;
  return {
    title,
    body: parts.join(options.separator ?? " · "),
    data: options.data
      ? options.data(rows)
      : { type: "aggregate", count: rows.length },
  };
}
