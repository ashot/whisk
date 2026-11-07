import { afterEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { groupCandidates, parseClusterVerdict, parseThemeVerdict, clusterSystem, MIN_TOPIC, trimName } from "./ai/grouping";
import { parseJudgeVerdict } from "./ai/judge";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./demo.ts": () => import("./demo"),
  "./dispatch.ts": () => import("./dispatch"),
  "./sync.ts": () => import("./sync"),
  "./clusters.ts": () => import("./clusters"),
  "./filters.ts": () => import("./filters"),
  "./ai/filterSupport.ts": () => import("./ai/filterSupport"),
};
const activeTests: ReturnType<typeof convexTest>[] = [];
afterEach(async () => {
  for (const t of activeTests.splice(0)) {
    await t.run(async ctx => {
      const jobs = await ctx.db.system.query("_scheduled_functions").collect();
      for (const job of jobs) if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
});
async function setup() {
  const t = convexTest(schema, modules);
  activeTests.push(t);
  const { token, accountId } = await t.mutation(api.demo.seed, {});
  const page = await t.query(api.sync.listThreads, { token });
  const thread = page.rows.find(t => t.label_ids.includes("INBOX"))!;
  const dispatch = (action: string, args: object) => t.mutation(api.dispatch.dispatch, { token, action, args: [{ ...args, account_id: accountId }] });
  return { t, token, accountId: accountId!, thread, dispatch };
}

describe("grouping verdicts", () => {
  test("missing assignments and unknown destinations never become silent nonmatches", () => {
    expect(() => parseClusterVerdict({ new: [], assign: {} }, [{ gmail_id: "one" }], [])).toThrow();
    expect(() => parseClusterVerdict({ new: [], assign: { "0": "fake" } }, [{ gmail_id: "one" }], [])).toThrow();
    expect(() => parseClusterVerdict({ new: "oops", assign: {} }, [], [])).toThrow();
  });
  test("new singleton topics are left separate; repeated mail forms a topic", () => {
    const raw = { new: [{ key: "n", name: "School admissions", description: "Application and tour discussions" }], assign: { "0": "n", "1": "n" } };
    expect(parseClusterVerdict(raw, [{ gmail_id: "one" }], []).newClusters).toEqual([]);
    expect(parseClusterVerdict(raw, [{ gmail_id: "one" }, { gmail_id: "two" }], []).assignments.map(a => a.target)).toEqual(["n", "n"]);
  });
  test("a quoted null or a topic named instead of its id still lands; unknown targets never pass silently", () => {
    const existing = [{ _id: "c1", name: "Cloudflare Billing" }];
    const parsed = parseClusterVerdict({ new: [], assign: { "0": "null", "1": "cloudflare billing", "2": null } }, [{ gmail_id: "a" }, { gmail_id: "b" }, { gmail_id: "c" }], existing);
    expect(parsed.assignments.map(a => a.target)).toEqual([null, "c1", null]);
    expect(() => parseClusterVerdict({ new: [], assign: { "0": "Cloudflare" } }, [{ gmail_id: "a" }], existing)).toThrow();
  });
  test("long names are cut on a word boundary, never mid-word", () => {
    expect(trimName("Preschool Admissions (Beansprouts & Brooklyn Preschool of Science)")).toBe("Preschool Admissions (Beansprouts & Brooklyn");
    expect(trimName("  Two   words ")).toBe("Two words");
    expect(trimName("x".repeat(60))).toBe("x".repeat(48));
  });
  test("judge verdicts use prefixed ids and refuse anything else", () => {
    expect(parseJudgeVerdict({ t0: ["f1"], t1: [], t2: ["f0", "f0"] }, 3, 2)).toEqual([[1], [], [0]]);
    expect(() => parseJudgeVerdict({ t0: ["f2"] }, 1, 2)).toThrow();
    expect(() => parseJudgeVerdict({ t0: [1] }, 1, 2)).toThrow();
    expect(() => parseJudgeVerdict({ "0": ["f0"] }, 1, 2)).toThrow();
    expect(() => parseJudgeVerdict(null, 1, 1)).toThrow();
  });
  test("the viability threshold follows granularity and is told to the model", () => {
    const raw = { new: [{ key: "n", name: "Vendor offers", description: "" }], assign: { "0": "n", "1": "n", "2": null } };
    const batch = [{ gmail_id: "one" }, { gmail_id: "two" }, { gmail_id: "three" }];
    expect(parseClusterVerdict(raw, batch, [], MIN_TOPIC.balanced).newClusters).toEqual([]);
    expect(parseClusterVerdict(raw, batch, [], MIN_TOPIC.balanced).assignments.map(a => a.target)).toEqual([null, null, null]);
    expect(parseClusterVerdict(raw, batch, [], MIN_TOPIC.more).newClusters).toHaveLength(1);
    expect(clusterSystem({ granularity: "fewer", preferences: [] })).toContain(`at least ${MIN_TOPIC.fewer} threads`);
  });
  test("theme verdicts place every topic once, keep the person's topics and themes as they are, and drop empty themes", () => {
    const input = {
      themes: [{ _id: "T1", name: "My money", description: "Mine", mine: true, size: 4 }],
      topics: [
        { _id: "a", name: "Cloudflare Invoices", description: "", size: 4, mine: false, senders: ["cloudflare.com"], lanes: ["receipts"], samples: [] },
        { _id: "b", name: "Cloudflare Usage Alerts", description: "", size: 1, mine: false, senders: ["cloudflare.com"], lanes: ["notifications"], samples: [] },
        { _id: "c", name: "School admissions", description: "", size: 3, mine: true, senders: ["school.org"], lanes: ["primary"], samples: [] },
        { _id: "d", name: "Temu Deals", description: "", size: 9, mine: false, senders: ["temu.com"], lanes: ["promotions"], samples: [] },
      ],
      senders: [{ key: "ring.com", name: "Ring", size: 2, lane: "promotions", samples: [] }],
    };
    const parsed = parseThemeVerdict({
      themes: [
        { id: "T1", name: "Renamed", description: "Changed", topics: ["a", "b", "zzz"], senders: [] },
        { key: "t2", name: "Shopping and deals", description: "Things bought and offers", topics: ["d", "a"], senders: ["ring.com", "nope.com"] },
        { key: "t3", name: "Empty", description: "", topics: [], senders: [] },
        { key: "t4", name: "School", description: "", topics: ["c"], senders: [] },
      ],
      merge: [{ into: "a", from: ["b", "c"] }, { into: "d", from: ["b"] }],
    }, input);
    // The merge folds only b (c is the person's); b then appears in no theme.
    expect(parsed.merges).toEqual([{ into: "a", from: ["b"] }]);
    expect(parsed.themes.map(t => [t.id ?? t.key, t.name, t.topics, t.senders])).toEqual([
      ["T1", "My money", ["a"], []],
      ["t2", "Shopping and deals", ["d"], ["ring.com"]],
      ["t4", "School", ["c"], []],
    ]);
    expect(parsed.themes[0].description).toBe("Mine");
    expect(() => parseThemeVerdict(null, input)).toThrow();
    expect(() => parseThemeVerdict({ merge: [] }, input)).toThrow();
  });
});

test("an incremental pass re-offers unclustered mail once per window, a fresh one never needs to", async () => {
  const { t, accountId } = await setup();
  const first = await t.mutation(internal.clusters.beginPass, { accountId });
  expect(first.revisit).toBe(true);
  await t.mutation(internal.clusters.finishPass, { accountId, startedAt: first.startedAt });
  const second = await t.mutation(internal.clusters.beginPass, { accountId });
  expect(second.revisit).toBe(false);
  expect((await t.run(ctx => ctx.db.get(accountId)))?.cluster_revisited_at).toBe(first.startedAt);
  // A continuation keeps its generation and never re-decides.
  expect((await t.mutation(internal.clusters.beginPass, { accountId, startedAt: second.startedAt })).revisit).toBe(false);
});

test("a model topic dissolves when its last inbox thread leaves, and an archived member alone keeps it out of the roster", async () => {
  const { t, accountId, thread } = await setup();
  const id = await t.run(async ctx => {
    const id = await ctx.db.insert("clusters", { account_id: accountId, name: "Old receipts", description: "", hue: 1, source: "ai", created_at: 1, updated_at: 1 });
    await ctx.db.patch(accountId, { cluster_started_at: 100 });
    await ctx.db.patch(thread._id, { cluster_id: id, cluster_source: "ai", label_ids: thread.label_ids.filter(l => l !== "INBOX") });
    return id;
  });
  const result = await t.mutation(internal.clusters.applyPass, { accountId, startedAt: 100, newClusters: [], assignments: [] });
  expect(result.dissolved).toBe(1);
  expect((await t.run(ctx => ctx.db.get(id)))?.deleted).toBe(true);
});

test("a dead grouping run loses its pulse after the stale window; a live young one keeps it", async () => {
  const { t, accountId } = await setup();
  await t.run(async ctx => { await ctx.db.patch(accountId, { cluster_started_at: Date.now() - 30 * 60 * 1000, cluster_progress: { done: 3, total: 9, review: false } }); });
  expect((await t.mutation(internal.clusters.sweepStaleRuns, {})).cleared).toBe(1);
  const account = await t.run(ctx => ctx.db.get(accountId));
  expect(account?.cluster_started_at).toBeUndefined();
  expect(account?.cluster_progress).toBeUndefined();
  await t.run(async ctx => { await ctx.db.patch(accountId, { cluster_started_at: Date.now(), cluster_job: await ctx.scheduler.runAfter(60_000, internal.clusters.sweepStaleRuns, {}) }); });
  expect((await t.mutation(internal.clusters.sweepStaleRuns, {})).cleared).toBe(0);
});

test("regroup refuses while auto-group is off, and on-demand model calls draw on an hourly budget", async () => {
  const { t, accountId, dispatch } = await setup();
  const user = (await t.run(ctx => ctx.db.get(accountId)))!.user_id!;
  await t.run(async ctx => {
    const state = await ctx.db.query("client_state").withIndex("by_user", q => q.eq("user_id", user)).unique();
    if (state) await ctx.db.patch(state._id, { prefs: { clustering: { enabled: false } } });
    else await ctx.db.insert("client_state", { user_id: user, prefs: { clustering: { enabled: false } }, updated_at: 1 } as never);
  });
  await expect(dispatch("regroupClusters", { fresh: true })).rejects.toThrow(/Auto-group is off/);
  await t.run(async ctx => { await ctx.db.patch(accountId, { ai_window_start: Date.now(), ai_window_spent: 119 }); });
  await expect(t.mutation(internal.ai.filterSupport.takeModelBudget, { accountId, cost: 2 })).rejects.toThrow(/hour/);
  await t.mutation(internal.ai.filterSupport.takeModelBudget, { accountId, cost: 1 });
  expect((await t.run(ctx => ctx.db.get(accountId)))?.ai_window_spent).toBe(120);
});

test("a topic that archives new mail archives what arrives after the switch, never what was already there", async () => {
  const { t, accountId, thread, dispatch } = await setup();
  const { cluster_id } = await dispatch("createCluster", { name: "Temu Deals", thread_gmail_ids: [] });
  const before = await dispatch("setClusterTreatment", { cluster_id, archive_new: true, hidden: true });
  expect(before).toEqual({ hidden: true, archive_new: true });
  // The seeded thread predates the switch: placing it leaves it in the inbox.
  await dispatch("setThreadCluster", { cluster_id, thread_gmail_ids: [thread.gmail_id] });
  expect((await t.run(ctx => ctx.db.get(thread._id)))?.label_ids).toContain("INBOX");
  // A thread first seen after the switch leaves the inbox as it joins.
  const since = (await t.run(ctx => ctx.db.get(cluster_id as never)) as { archive_new_since: number }).archive_new_since;
  await t.run(async ctx => { await ctx.db.patch(cluster_id as never, { archive_new_since: since - 60_000 } as never); });
  const fresh = await t.run(async ctx => {
    const id = await ctx.db.insert("threads", { ...thread, _id: undefined, _creationTime: undefined, gmail_id: "fresh-1", cluster_id: undefined, cluster_source: undefined, label_ids: ["INBOX", "UNREAD"] } as never);
    return (await ctx.db.get(id))!;
  });
  await dispatch("setThreadCluster", { cluster_id, thread_gmail_ids: [fresh.gmail_id] });
  const landed = await t.run(ctx => ctx.db.get(fresh._id));
  expect(landed?.cluster_id).toBe(cluster_id);
  expect(landed?.label_ids).not.toContain("INBOX");
  expect(await t.run(ctx => ctx.db.query("outbound").withIndex("by_account_status", q => q.eq("account_id", accountId)).collect())).toHaveLength(1);
  // Switching it off clears the stamp; hidden stays as set.
  expect(await dispatch("setClusterTreatment", { cluster_id, archive_new: false })).toEqual({ hidden: true, archive_new: false });
});

test("a theme verdict merges streams, files them under a theme, places loose senders, and unfiles what it left out", async () => {
  const { t, accountId, thread } = await setup();
  const ids = await t.run(async ctx => {
    const into = await ctx.db.insert("clusters", { account_id: accountId, name: "Cloudflare Billing", description: "", hue: 10, source: "ai", created_at: 1, updated_at: 1 });
    const from = await ctx.db.insert("clusters", { account_id: accountId, name: "Cloudflare Usage Alerts", description: "", hue: 20, source: "ai", created_at: 1, updated_at: 1 });
    const stale = await ctx.db.insert("clusters", { account_id: accountId, name: "Old theme", description: "", hue: 30, source: "ai", kind: "theme", created_at: 1, updated_at: 1 });
    const orphan = await ctx.db.insert("clusters", { account_id: accountId, name: "Temu Deals", description: "", hue: 40, source: "ai", parent_id: stale, created_at: 1, updated_at: 1 });
    await ctx.db.patch(accountId, { cluster_started_at: 100 });
    await ctx.db.patch(thread._id, { cluster_id: from, cluster_source: "ai" });
    return { into, from, stale, orphan };
  });
  const loose = await t.run(async ctx => {
    const id = await ctx.db.insert("threads", { ...thread, _id: undefined, _creationTime: undefined, gmail_id: "loose-1", cluster_id: undefined, cluster_source: "ai", participants: [{ name: "Ring", email: "news@ring.com" }], label_ids: ["INBOX"] } as never);
    return (await ctx.db.get(id))!;
  });
  const result = await t.mutation(internal.clusters.applyThemes, { accountId, startedAt: 100, merges: [{ into: ids.into, from: [ids.from] }], themes: [{ key: "t1", name: "Money", description: "Bills and statements", topics: [ids.into], senders: ["ring.com"] }] });
  expect(result).toEqual({ merged: 1, themed: 1, placed: 1 });
  const money = (await t.run(ctx => ctx.db.query("clusters").collect())).find(c => c.name === "Money")!;
  expect(money.kind).toBe("theme");
  expect((await t.run(ctx => ctx.db.get(thread._id)))?.cluster_id).toBe(ids.into);
  expect((await t.run(ctx => ctx.db.get(ids.from)))?.deleted).toBe(true);
  expect((await t.run(ctx => ctx.db.get(ids.into)))?.parent_id).toBe(money._id);
  expect((await t.run(ctx => ctx.db.get(loose._id)))?.cluster_id).toBe(money._id);
  // The stream the verdict left out stands on its own; its emptied theme goes.
  expect((await t.run(ctx => ctx.db.get(ids.orphan)))?.parent_id).toBeUndefined();
  expect((await t.run(ctx => ctx.db.get(ids.stale)))?.deleted).toBe(true);
  // A stale generation does nothing.
  const stale = await t.mutation(internal.clusters.applyThemes, { accountId, startedAt: 5, merges: [], themes: [{ id: money._id, name: "Nope", description: "", topics: [], senders: [] }] });
  expect(stale.themed).toBe(0);
});

test("manual placement and dissolution survive model regrouping", async () => {
  const { t, accountId, thread, dispatch } = await setup();
  const { cluster_id } = await dispatch("createCluster", { name: "School admissions", thread_gmail_ids: [thread.gmail_id] });
  await t.run(async ctx => { await ctx.db.patch(accountId, { cluster_started_at: 100 }); });
  await t.mutation(internal.clusters.applyPass, { accountId, startedAt: 100, newClusters: [], assignments: [{ thread_gmail_id: thread.gmail_id, target: null }] });
  expect((await t.run(ctx => ctx.db.get(thread._id)))?.cluster_id).toBe(cluster_id);
  expect((await t.query(internal.clusters.candidates, { accountId, fresh: true, limit: 200 })).some(t => t.gmail_id === thread.gmail_id)).toBe(false);
  await dispatch("dissolveCluster", { cluster_id });
  const freed = await t.run(ctx => ctx.db.get(thread._id));
  expect(freed?.cluster_source).toBe("user");
  expect(freed?.cluster_id).toBeUndefined();
  expect(freed?.label_ids).toEqual(thread.label_ids);
});

test("stale or paused grouping passes cannot create topics or move mail", async () => {
  const { t, accountId, thread } = await setup();
  const result = await t.mutation(internal.clusters.applyPass, { accountId, startedAt: 999, newClusters: [{ key: "n", name: "Wrong", description: "" }], assignments: [{ thread_gmail_id: thread.gmail_id, target: "n" }] });
  expect(result.created).toBe(0);
  expect((await t.run(ctx => ctx.db.query("clusters").collect())).some(c => c.name === "Wrong")).toBe(false);
});

test("filters enforce ownership, reject stale versions and apply retry hits once", async () => {
  const { t, accountId, thread, dispatch } = await setup();
  const saved = await dispatch("saveFilter", { text: "Star messages about this project", condition: "This project is discussed", actions: [{ kind: "star" }] });
  const hit = { filter_id: saved.filter_id, thread_gmail_id: thread.gmail_id, revision: 0, last_at: thread.last_at, message_count: thread.message_count };
  const second = await t.mutation(api.demo.seed, {});
  expect((await t.mutation(internal.filters.applyHits, { includeOlder: true, accountId: second.accountId!, hits: [hit] })).applied).toBe(0);
  const before = (await t.run(ctx => ctx.db.query("outbound").collect())).length;
  expect((await t.mutation(internal.filters.applyHits, { includeOlder: true, accountId, hits: [hit, hit] })).applied).toBe(1);
  expect((await t.mutation(internal.filters.applyHits, { includeOlder: true, accountId, hits: [hit] })).applied).toBe(0);
  expect((await t.run(ctx => ctx.db.query("outbound").collect())).length).toBe(before + 1);
  expect((await t.run(ctx => ctx.db.get(thread._id)))?.is_starred).toBe(true);
  await dispatch("saveFilter", { filter_id: saved.filter_id, text: "Archive this project", condition: "This project is discussed", actions: [{ kind: "archive" }] });
  expect((await t.mutation(internal.filters.applyHits, { includeOlder: true, accountId, hits: [hit] })).applied).toBe(0);
  expect((await t.run(ctx => ctx.db.get(thread._id)))?.label_ids).toContain("INBOX");
  await dispatch("setFilterEnabled", { filter_id: saved.filter_id, enabled: false });
  expect((await t.mutation(internal.filters.applyHits, { includeOlder: true, accountId, hits: [{ ...hit, revision: 2 }] })).applied).toBe(0);
});

test("filter verdicts reject changed conversations and fabricated system-label actions", async () => {
  const { t, accountId, thread, dispatch } = await setup();
  await expect(dispatch("saveFilter", { text: "Delete everything", condition: "All mail", actions: [{ kind: "label", arg: "TRASH" }] })).rejects.toThrow();
  const saved = await dispatch("saveFilter", { text: "Archive project mail", condition: "Project mail", actions: [{ kind: "archive" }] });
  const hit = { filter_id: saved.filter_id, thread_gmail_id: thread.gmail_id, revision: 0, last_at: thread.last_at - 1, message_count: thread.message_count };
  expect((await t.mutation(internal.filters.applyHits, { includeOlder: true, accountId, hits: [hit] })).applied).toBe(0);
  expect((await t.run(ctx => ctx.db.get(thread._id)))?.label_ids).toContain("INBOX");
});

test("candidate ordering brings distant repetitions together without mutating the snapshot", () => {
  const rows = [{ from: "B <b@vendor.test>", subject: "Receipt" }, { from: "A <a@elsewhere.test>", subject: "Question" }, { from: "B <b@vendor.test>", subject: "Order" }];
  expect(groupCandidates(rows).map(r => r.subject)).toEqual(["Question", "Order", "Receipt"]);
  expect(rows[0].subject).toBe("Receipt");
});

test("renaming while a model call is in flight makes the topic the person's and protects its membership", async () => {
  const { t, accountId, thread, dispatch } = await setup();
  const cluster = await t.run(async ctx => {
    const id = await ctx.db.insert("clusters", { account_id: accountId, name: "Preserve", description: "", hue: 10, source: "ai", created_at: 1, updated_at: 1 });
    await ctx.db.patch(thread._id, { cluster_id: id, cluster_source: "ai" });
    await ctx.db.patch(accountId, { cluster_started_at: 100 });
    return id;
  });
  await dispatch("renameCluster", { cluster_id: cluster, name: "Keep" });
  await t.mutation(internal.clusters.applyPass, { accountId, startedAt: 100, newClusters: [], assignments: [{ thread_gmail_id: thread.gmail_id, target: null }] });
  expect((await t.run(ctx => ctx.db.get(thread._id)))?.cluster_id).toBe(cluster);
});

test("continuations preserve the job generation and cannot resurrect an obsolete pass", async () => {
  const { t, accountId } = await setup();
  const { startedAt } = await t.mutation(internal.clusters.beginPass, { accountId });
  await t.mutation(internal.clusters.continuePass, { accountId, startedAt, fresh: true, pending: [], remaining: [], review: true, done: 0, total: 0, created: 0 });
  const account = await t.run(ctx => ctx.db.get(accountId));
  expect(account?.cluster_job).toBeDefined();
  expect((await t.mutation(internal.clusters.beginPass, { accountId, startedAt })).startedAt).toBe(startedAt);
  await t.mutation(internal.clusters.finishPass, { accountId, startedAt });
  await t.mutation(internal.clusters.continuePass, { accountId, startedAt, fresh: true, pending: [], remaining: [], review: true, done: 0, total: 0, created: 0 });
  expect((await t.run(ctx => ctx.db.get(accountId)))?.cluster_job).toBeUndefined();
});

test("filter saves are retry-safe and editing never re-enables a paused filter", async () => {
  const { t, dispatch } = await setup();
  const fields = { text: "Star project requests", condition: "Project request", actions: [{ kind: "star" }] };
  const { filter_id } = await dispatch("saveFilter", fields);
  await dispatch("saveFilter", fields);
  expect((await t.run(ctx => ctx.db.get(filter_id)))?.revision ?? 0).toBe(0);
  await dispatch("setFilterEnabled", { filter_id, enabled: false });
  await dispatch("setFilterEnabled", { filter_id, enabled: false });
  await dispatch("saveFilter", { ...fields, filter_id, condition: "Project requests needing a reply" });
  const row = await t.run(ctx => ctx.db.get(filter_id));
  expect(row?.enabled).toBe(false);
  expect(row?.revision).toBe(2);
});

test("fresh regroup reuses matching names and makes their revised boundaries available to following batches", async () => {
  const { t, accountId, thread } = await setup();
  const id = await t.run(async ctx => {
    const id = await ctx.db.insert("clusters", { account_id: accountId, name: "Orders", description: "Old definition", hue: 10, source: "ai", created_at: 1, updated_at: 1 });
    await ctx.db.patch(accountId, { cluster_started_at: 100 });
    await ctx.db.patch(thread._id, { cluster_id: undefined, cluster_source: undefined });
    return id;
  });
  await t.mutation(internal.clusters.applyPass, { accountId, startedAt: 100, newClusters: [{ key: "n", name: "Orders", description: "Receipts, not offers" }], assignments: [{ thread_gmail_id: thread.gmail_id, target: "n" }] });
  const roster = await t.query(internal.clusters.roster, { accountId });
  const c = roster.clusters.find(c => c._id === id)!;
  expect(c.description).toBe("Receipts, not offers");
  expect(c.updated_at).toBeGreaterThanOrEqual(100);
  expect(roster.clusters.filter(c => c.name === "Orders")).toHaveLength(1);
});

test("backfilled old mail is not treated as a new arrival unless explicitly running an existing-inbox filter", async () => {
  const { t, accountId, thread, dispatch } = await setup();
  const { filter_id } = await dispatch("saveFilter", { text: "Star requests", condition: "A request", actions: [{ kind: "star" }] });
  const hit = { filter_id, thread_gmail_id: thread.gmail_id, revision: 0, last_at: thread.last_at, message_count: thread.message_count };
  expect((await t.mutation(internal.filters.applyHits, { accountId, hits: [hit] })).applied).toBe(0);
  expect((await t.mutation(internal.filters.applyHits, { accountId, includeOlder: true, hits: [hit] })).applied).toBe(1);
});

test("pausing automatic grouping prevents in-flight writes and clears continuation state", async () => {
  const { t, accountId, thread } = await setup();
  const { startedAt } = await t.mutation(internal.clusters.beginPass, { accountId });
  await t.run(async ctx => {
    const account = await ctx.db.get(accountId);
    const state = await ctx.db.query("client_state").withIndex("by_user", q => q.eq("user_id", account!.user_id!)).unique();
    await ctx.db.patch(state!._id, { prefs: { clustering: { enabled: false } } });
  });
  const result = await t.mutation(internal.clusters.applyPass, { accountId, startedAt, newClusters: [{ key: "n", name: "Must not exist", description: "" }], assignments: [{ thread_gmail_id: thread.gmail_id, target: "n" }] });
  expect(result.created).toBe(0);
  await t.mutation(internal.clusters.continuePass, { accountId, startedAt, fresh: true, pending: [thread.gmail_id], remaining: [], review: false, done: 0, total: 0, created: 0 });
  expect((await t.run(ctx => ctx.db.get(accountId)))?.cluster_started_at).toBeUndefined();
});

test("mail arriving during a grouping run schedules one follow-up instead of being lost", async () => {
  const { t, accountId } = await setup();
  const { startedAt } = await t.mutation(internal.clusters.beginPass, { accountId });
  await t.run(ctx => ctx.db.patch(accountId, { cluster_dirty: true }));
  await t.mutation(internal.clusters.finishPass, { accountId, startedAt });
  const row = await t.run(ctx => ctx.db.get(accountId));
  expect(row?.cluster_job).toBeDefined();
  expect(row?.cluster_dirty).toBeUndefined();
  expect(row?.cluster_started_at).toBeUndefined();
});
