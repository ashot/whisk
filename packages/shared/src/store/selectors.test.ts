import { describe, expect, test } from "bun:test";
import { inboxItems, inboxListCounts, laneCounts, threadInView, viewSlice, visibleThreads } from "./selectors";
import { IMPORTANT, lensesFromPrefs, type Lens } from "../lib/lenses";
import { L, type Thread } from "./types";

let seq = 0;
function thread(labels: string[], overrides: Partial<Thread> = {}): Thread {
  seq++;
  return {
    _id: `t${seq}`,
    account_id: "acct",
    gmail_id: `g${seq}`,
    subject: `Subject ${seq}`,
    snippet: "snippet",
    participants: [{ name: "Ada Lovelace", email: "ada@example.com" }],
    message_count: 1,
    last_at: seq,
    label_ids: labels,
    is_unread: labels.includes(L.UNREAD),
    is_starred: labels.includes(L.STARRED),
    has_attachments: false,
    updated_at: seq,
    ...overrides,
  };
}

describe("threadInView", () => {
  test("inbox excludes trash and spam", () => {
    expect(threadInView(thread([L.INBOX]), "inbox")).toBe(true);
    expect(threadInView(thread([L.INBOX, L.TRASH]), "inbox")).toBe(false);
    expect(threadInView(thread([L.INBOX, L.SPAM]), "inbox")).toBe(false);
  });

  test("archive is the not-anywhere-else bucket", () => {
    expect(threadInView(thread([]), "archive")).toBe(true);
    expect(threadInView(thread([L.SENT]), "archive")).toBe(true);
    expect(threadInView(thread([L.INBOX]), "archive")).toBe(false);
    expect(threadInView(thread([L.TRASH]), "archive")).toBe(false);
  });

  test("trash shows trashed threads regardless of other labels", () => {
    expect(threadInView(thread([L.TRASH, L.INBOX]), "trash")).toBe(true);
  });

  test("label views filter by gmail label id", () => {
    expect(threadInView(thread(["Label_1", L.INBOX]), "label:Label_1")).toBe(true);
    expect(threadInView(thread([L.INBOX]), "label:Label_1")).toBe(false);
  });

  test("search matches subject, snippet, participants", () => {
    const t = thread([L.INBOX], { subject: "Quarterly review" });
    expect(threadInView(t, "search:quarterly")).toBe(true);
    expect(threadInView(t, "search:ada")).toBe(true);
    expect(threadInView(t, "search:zzz")).toBe(false);
  });

  test("search speaks the server grammar: operators and phrases", () => {
    const unread = thread([L.INBOX, L.UNREAD], { subject: "Wedding plans" });
    const read = thread([L.INBOX], { subject: "Wedding photos", has_attachments: true });
    expect(threadInView(unread, "search:is:unread wedding")).toBe(true);
    expect(threadInView(read, "search:is:unread wedding")).toBe(false);
    expect(threadInView(read, "search:has:attachment")).toBe(true);
    expect(threadInView(unread, "search:from:ada")).toBe(true);
    expect(threadInView(unread, "search:from:grace")).toBe(false);
    expect(threadInView(unread, 'search:"wedding plans"')).toBe(true);
    expect(threadInView(unread, 'search:"plans wedding"')).toBe(false);
    // label: by id always; by name when the label table is at hand.
    const filed = thread([L.INBOX, "Label_7"]);
    const labels = {
      l7: { _id: "l7", account_id: "acct", gmail_id: "Label_7", name: "Clients", kind: "user" as const, updated_at: 1 },
    };
    expect(threadInView(filed, "search:label:Label_7")).toBe(true);
    expect(threadInView(filed, "search:label:clients")).toBe(false);
    expect(threadInView(filed, "search:label:clients", labels)).toBe(true);
    expect(threadInView(unread, "search:label:clients", labels)).toBe(false);
  });

  test("deleted threads never render", () => {
    expect(threadInView(thread([L.INBOX], { deleted: true }), "inbox")).toBe(false);
  });
});

describe("visibleThreads", () => {
  test("sorts newest first", () => {
    const a = thread([L.INBOX], { last_at: 10 });
    const b = thread([L.INBOX], { last_at: 30 });
    const c = thread([L.INBOX], { last_at: 20 });
    const out = visibleThreads({ [a._id]: a, [b._id]: b, [c._id]: c }, "inbox");
    expect(out.map((t) => t.last_at)).toEqual([30, 20, 10]);
  });
});

describe("lenses", () => {
  const lenses: Lens[] = [
    { id: IMPORTANT, name: "Important", cutoff: 50, revision: 0 },
    { id: "kids", name: "Kids", policy: "School and childcare", cutoff: 60, revision: 1 },
  ];

  test("a score at or above the cutoff puts inbox mail in a lens; Other is what Important leaves", () => {
    const unjudged = thread([L.INBOX]);
    const high = thread([L.INBOX], { lens_scores: { important: 80, kids: 70 } });
    const low = thread([L.INBOX], { lens_scores: { important: 20, kids: 30 } });
    expect(threadInView(unjudged, "inbox", undefined, lenses)).toBe(true);
    expect(threadInView(unjudged, "lens:kids", undefined, lenses)).toBe(false);
    expect(threadInView(high, "inbox", undefined, lenses)).toBe(true);
    expect(threadInView(high, "lens:kids", undefined, lenses)).toBe(true);
    expect(threadInView(low, "other", undefined, lenses)).toBe(true);
    expect(threadInView(low, "lens:kids", undefined, lenses)).toBe(false);
    expect(threadInView(thread([], { lens_scores: { important: 20 } }), "other", undefined, lenses)).toBe(false);
  });

  test("moving a cutoff moves threads, and a hand placement does not move", () => {
    const mid = thread([L.INBOX], { lens_scores: { important: 40 } });
    const placed = thread([L.INBOX], { lens_scores: { important: 90 }, lens_marks: { important: false } });
    const looser = [{ ...lenses[0], cutoff: 35 }, lenses[1]];
    expect(threadInView(mid, "inbox", undefined, lenses)).toBe(false);
    expect(threadInView(mid, "inbox", undefined, looser)).toBe(true);
    expect(threadInView(placed, "inbox", undefined, looser)).toBe(false);
  });

  test("lanes count the whole inbox; the tabs count each list", () => {
    const all = Object.fromEntries([
      thread([L.INBOX, L.UNREAD], { lens_scores: { important: 90, kids: 10 } }),
      thread([L.INBOX, L.UNREAD], { lens_scores: { important: 10, kids: 90 }, category: "newsletters" }),
      thread([L.INBOX], { lens_scores: { important: 10, kids: 10 }, category: "newsletters" }),
    ].map((t) => [t._id, t]));
    expect(laneCounts(all).get("newsletters")).toEqual({ total: 2, unread: 1 });
    const counts = inboxListCounts(all, undefined, lenses);
    expect(counts.get("inbox")).toEqual({ total: 1, unread: 1 });
    expect(counts.get("lens:kids")).toEqual({ total: 1, unread: 1 });
    expect(counts.get("other")).toEqual({ total: 2, unread: 1 });
  });

  test("grouping a list as topics keeps to that list, and follows its cutoff", () => {
    const cluster = { _id: "c1", account_id: "acct", name: "Sentry", description: "", hue: 10, source: "ai" as const, created_at: 0, updated_at: 0 };
    const a = thread([L.INBOX], { cluster_id: "c1", lens_scores: { important: 30 } });
    const b = thread([L.INBOX], { cluster_id: "c1" });
    const all = { [a._id]: a, [b._id]: b };
    const ids = (view: "inbox" | "other", ls: Lens[]) => inboxItems(all, { c1: cluster }, undefined, undefined, viewSlice(view, ls)!).filter((i) => i.kind === "thread").map((i) => i.id);
    expect(ids("other", lenses)).toEqual([a._id]);
    expect(ids("inbox", lenses)).toEqual([b._id]);
    const looser = [{ ...lenses[0], cutoff: 25 }, lenses[1]];
    expect(ids("other", looser)).toEqual([]);
    expect(inboxItems(all, { c1: cluster }, undefined, "c1").filter((i) => i.kind === "thread")).toHaveLength(2);
  });

  test("the earlier importance pref still reads as Important's description", () => {
    expect(lensesFromPrefs({ importance: { policy: "Only my sister", revision: 3 } })).toEqual([
      { id: IMPORTANT, name: "Important", policy: "Only my sister", cutoff: 50, revision: 3 },
    ]);
    expect(lensesFromPrefs({ lenses: [{ id: "kids", name: "Kids", policy: "x", cutoff: 200, revision: 1 }] }).map((l) => [l.id, l.cutoff])).toEqual([[IMPORTANT, 50], ["kids", 95]]);
  });
});
