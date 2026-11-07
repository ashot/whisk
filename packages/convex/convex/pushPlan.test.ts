import { expect, test } from "bun:test";
import { DEFAULT_NOTIFICATION_PREFS, modelWorkSettled } from "@mail/shared/src/lib/notifications";
import type { Thread } from "@mail/shared/src/store/types";
import { newMailPushes, pushesWantingSummary, wallClock, SOLO_LIMIT } from "./lib/pushPlan";

const me = "nora@driftwork.io";
const mk = (id: string, extra: Partial<Thread> = {}): Thread => ({
  _id: `row-${id}`, account_id: "acct", gmail_id: id, subject: `Subject ${id}`, snippet: "", participants: [{ name: `Sender-${id}`, email: `${id}@example.com` }],
  message_count: 1, last_at: 1, label_ids: ["INBOX", "UNREAD"], is_unread: true, is_starred: false, has_attachments: false, updated_at: 1, ...extra,
});
const prefs = DEFAULT_NOTIFICATION_PREFS;
const now = new Date(2026, 8, 13, 14, 0);

test("primary mail earns one push each with the sender and subject; a filed lane and a muted topic stay quiet", () => {
  const pushes = newMailPushes({ threads: [mk("a"), mk("b", { category: "newsletters" as never }), mk("c", { cluster_id: "topic" })], prefs, me: { email: me }, clusters: { topic: { hidden: true } }, now });
  expect(pushes).toHaveLength(1);
  expect(pushes[0]).toMatchObject({ title: "Sender-a", body: "Subject a", sound: "default", data: { kind: "mail", thread_id: "row-a", thread_gmail_id: "a", account_id: "acct" } });
  expect(pushes[0].interruptionLevel).toBeUndefined();
});

test("the model's summary is the push body, under the subject, and only full previews ask for one", () => {
  const input = { threads: [mk("a"), mk("b")], prefs, me: { email: me }, now };
  const before = newMailPushes(input);
  expect(pushesWantingSummary(input, before)).toEqual(["a", "b"]);
  const withSummary = { ...input, summaries: { a: "Ada needs the contract signed by Friday." } };
  const after = newMailPushes(withSummary);
  expect(after[0]).toMatchObject({ title: "Sender-a", subtitle: "Subject a", body: "Ada needs the contract signed by Friday." });
  expect(after[1]).toMatchObject({ title: "Sender-b", body: "Subject b" });
  expect(pushesWantingSummary(withSummary, after)).toEqual(["b"]);
  const discreet = { ...input, prefs: { ...prefs, preview: "sender" as const } };
  expect(pushesWantingSummary(discreet, newMailPushes(discreet))).toEqual([]);
  const digest = { ...input, threads: Array.from({ length: SOLO_LIMIT + 1 }, (_, i) => mk(`d${i}`)) };
  expect(pushesWantingSummary(digest, newMailPushes(digest))).toEqual([]);
});

test("past the solo limit one digest names the senders", () => {
  const threads = Array.from({ length: SOLO_LIMIT + 2 }, (_, i) => mk(`t${i}`));
  const pushes = newMailPushes({ threads, prefs, me: { email: me }, now });
  expect(pushes).toHaveLength(1);
  expect(pushes[0].title).toBe(`${SOLO_LIMIT + 2} new messages`);
  expect(pushes[0].body).toBe("Sender-t0, Sender-t1, Sender-t2, Sender-t3 and 1 more");
  expect(pushes[0].data).toMatchObject({ kind: "mail-digest" });
  expect(pushes[0].contentAvailable).toBeUndefined();
  expect(newMailPushes({ threads: [mk("a")], prefs, meEmail: me, now })[0].contentAvailable).toBe(true);
});

test("notifications off, or quiet hours on the person's clock, send nothing; a preview of none hides the words", () => {
  expect(newMailPushes({ threads: [mk("a")], prefs: { ...prefs, enabled: false }, me: { email: me }, now })).toEqual([]);
  const quiet = { ...prefs, quiet: { enabled: true, from: "22:00", to: "08:00", days: [], allowVip: true } };
  expect(newMailPushes({ threads: [mk("a")], prefs: quiet, me: { email: me }, now: new Date(2026, 8, 13, 23, 0) })).toEqual([]);
  expect(newMailPushes({ threads: [mk("a")], prefs: quiet, me: { email: me }, now })).toHaveLength(1);
  expect(newMailPushes({ threads: [mk("a")], prefs: { ...prefs, preview: "none" }, me: { email: me }, now })[0]).toMatchObject({ title: "Whisk", body: "New message" });
});

test("wallClock answers in the phone's zone", () => {
  const utcNoon = new Date(Date.UTC(2026, 0, 15, 12, 0));
  expect(wallClock(utcNoon, "America/New_York").getHours()).toBe(7);
  expect(wallClock(utcNoon, "Asia/Tokyo").getHours()).toBe(21);
  expect(wallClock(utcNoon, "Not/AZone")).toBe(utcNoon);
});

test("a push goes out once the model has placed every thread and every enabled filter has checked since the sync; with no model it never waits", () => {
  const placed = { category_source: "heuristic" };
  const unplaced = {};
  expect(modelWorkSettled({ threads: [unplaced], filters: [], since: 100, modelOn: false })).toBe(true);
  expect(modelWorkSettled({ threads: [placed], filters: [], since: 100, modelOn: true })).toBe(true);
  expect(modelWorkSettled({ threads: [placed, unplaced], filters: [], since: 100, modelOn: true })).toBe(false);
  expect(modelWorkSettled({ threads: [placed], filters: [{ enabled: true, last_checked_at: 99 }], since: 100, modelOn: true })).toBe(false);
  expect(modelWorkSettled({ threads: [placed], filters: [{ enabled: true, last_checked_at: 100 }, { enabled: false }], since: 100, modelOn: true })).toBe(true);
});
