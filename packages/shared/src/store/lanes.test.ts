import { describe, expect, test } from "bun:test";
import {
  inboxClusters,
  laneCounts,
  liveReminders,
  threadInView,
  visibleThreads,
} from "./selectors";
import { followupOptions, snoozeOptions } from "../lib/times";
import type { Reminder, Thread } from "./types";

// The lane and reminder selectors — pure joins the whole discovery UI
// (rail counts, sweep cards, later/waiting views, row chips) renders from.

let seq = 0;
function thread(over: Partial<Thread>): Thread {
  seq++;
  return {
    _id: `t${seq}`,
    account_id: "a1",
    gmail_id: `g${seq}`,
    subject: `Subject ${seq}`,
    snippet: "…",
    participants: [{ name: "Sender", email: "sender@example.com" }],
    message_count: 1,
    last_at: 1000 + seq,
    label_ids: ["INBOX"],
    is_unread: false,
    is_starred: false,
    has_attachments: false,
    updated_at: 1,
    ...over,
  };
}

function reminder(over: Partial<Reminder>): Reminder {
  seq++;
  return {
    _id: `r${seq}`,
    account_id: "a1",
    thread_gmail_id: "g0",
    kind: "snooze",
    remind_at: 5000,
    baseline_last_at: 0,
    status: "armed",
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

const byId = <T extends { _id: string }>(rows: T[]) =>
  Object.fromEntries(rows.map((r) => [r._id, r]));

describe("lane views", () => {
  test("cat: views split the inbox; primary is the absence of a lane", () => {
    const filed = thread({ category: "newsletters" });
    const primary = thread({});
    const archived = thread({ category: "newsletters", label_ids: [] });
    expect(threadInView(filed, "cat:newsletters")).toBe(true);
    expect(threadInView(filed, "cat:primary")).toBe(false);
    expect(threadInView(primary, "cat:primary")).toBe(true);
    // Lane views are inbox views: what left the inbox left the lane.
    expect(threadInView(archived, "cat:newsletters")).toBe(false);
  });

  test("laneCounts tallies inbox threads per lane with unread", () => {
    const rows = byId([
      thread({ category: "newsletters", is_unread: true }),
      thread({ category: "newsletters" }),
      thread({ category: "receipts" }),
      thread({}),
      thread({ category: "receipts", label_ids: ["TRASH"] }), // out of inbox
    ]);
    const counts = laneCounts(rows);
    expect(counts.get("newsletters")).toEqual({ total: 2, unread: 1 });
    expect(counts.get("receipts")).toEqual({ total: 1, unread: 0 });
    expect(counts.get("primary")).toEqual({ total: 1, unread: 0 });
  });

  test("clusters come biggest first with senders tallied by volume", () => {
    const rows = byId([
      thread({ category: "notifications", participants: [{ email: "gh@x.com", name: "GitHub" }] }),
      thread({ category: "notifications", participants: [{ email: "gh@x.com", name: "GitHub" }] }),
      thread({ category: "notifications", participants: [{ email: "ci@x.com", name: "CI" }] }),
      thread({ category: "travel", participants: [{ email: "air@x.com", name: "Air" }] }),
      thread({}), // primary never clusters
    ]);
    const clusters = inboxClusters(rows);
    expect(clusters.map((c) => c.meta.id)).toEqual(["notifications", "travel"]);
    expect(clusters[0].senders[0]).toEqual({ name: "GitHub", email: "gh@x.com", count: 2 });
    // Recency order inside a cluster: newest first.
    const times = clusters[0].threads.map((t) => t.last_at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

describe("reminder views", () => {
  test("later holds armed snoozes, waiting holds the watches, soonest first", () => {
    const snoozed = thread({ label_ids: [] });
    const watched = thread({});
    const watchedLater = thread({});
    const rows = byId([snoozed, watched, watchedLater, thread({})]);
    const reminders = byId([
      reminder({ thread_gmail_id: snoozed.gmail_id, kind: "snooze", remind_at: 900 }),
      reminder({ thread_gmail_id: watchedLater.gmail_id, kind: "followup", remind_at: 800 }),
      reminder({ thread_gmail_id: watched.gmail_id, kind: "followup", remind_at: 300, status: "fired" }),
      reminder({ thread_gmail_id: "elsewhere", kind: "snooze", status: "canceled" }),
    ]);
    const later = visibleThreads(rows, "later", [], "all", reminders);
    expect(later.map((t) => t._id)).toEqual([snoozed._id]);
    const waiting = visibleThreads(rows, "waiting", [], "all", reminders);
    expect(waiting.map((t) => t._id)).toEqual([watched._id, watchedLater._id]);
  });

  test("liveReminders keys by account so gmail ids never collide across mailboxes", () => {
    const map = liveReminders(
      byId([
        reminder({ account_id: "a1", thread_gmail_id: "g9" }),
        reminder({ account_id: "a2", thread_gmail_id: "g9", kind: "followup" }),
      ]),
    );
    expect(map.get("a1:g9")?.kind).toBe("snooze");
    expect(map.get("a2:g9")?.kind).toBe("followup");
  });
});

describe("time menus", () => {
  test("snooze options are strictly future and free of duplicates", () => {
    // A Friday morning — where "tomorrow" and "the weekend" collide.
    const friday = new Date("2026-08-21T10:00:00").getTime();
    const options = snoozeOptions(friday);
    const ats = options.map((o) => o.at);
    expect(new Set(ats).size).toBe(ats.length);
    for (const at of ats) expect(at).toBeGreaterThan(friday);
  });

  test("followup options end on a monday when the week turns", () => {
    const friday = new Date("2026-08-21T10:00:00").getTime();
    const options = followupOptions(friday);
    const last = new Date(options[options.length - 1].at);
    expect(last.getDay()).toBe(1);
    expect(last.getHours()).toBe(9);
  });
});
