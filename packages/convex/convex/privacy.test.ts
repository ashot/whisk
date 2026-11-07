import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ruleKey, type PrivacyRule } from "@mail/shared/src/lib/privacy";
import { parsePrivacyVerdict } from "./ai/privacyJudge";
import { payloadMailRefs } from "./lib/privacy";

// Private mail: a login for agents (or a connected app) must never see,
// find, read, summarize, download or act on a thread the person keeps
// private, nor one not yet read against their rules; the person's own
// sessions see everything; only the person can change the rules or open a
// thread back up. These tests pin each of those gates through the same
// functions the CLI calls.

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./auth.ts": () => import("./auth"),
  "./demo.ts": () => import("./demo"),
  "./devices.ts": () => import("./devices"),
  "./dispatch.ts": () => import("./dispatch"),
  "./sync.ts": () => import("./sync"),
  "./search.ts": () => import("./search"),
  "./privacy.ts": () => import("./privacy"),
  "./reminders.ts": () => import("./reminders"),
  "./filters.ts": () => import("./filters"),
  "./clusters.ts": () => import("./clusters"),
  "./gmail/attachments.ts": () => import("./gmail/attachments"),
  "./ai/summarize.ts": () => import("./ai/summarize"),
  "./ai/draft.ts": () => import("./ai/draft"),
  "./ai/suggest.ts": () => import("./ai/suggest"),
  "./ai/filterSupport.ts": () => import("./ai/filterSupport"),
  "./ai/privacy.ts": () => import("./ai/privacy"),
  "./connect.ts": () => import("./connect"),
  "./memories.ts": () => import("./memories"),
};

const MEDICAL: PrivacyRule = { id: "p1", text: "Anything medical", revision: 1, created_at: 1 };

type T = ReturnType<typeof convexTest>;
type Row = { _id: string; gmail_id: string; account_id: Id<"accounts">; deleted?: boolean; message_count: number };

async function setup() {
  const t = convexTest(schema, modules);
  const { token: owner } = await t.mutation(api.demo.seed, {});
  const { token: agent } = await t.mutation(api.devices.mint, { token: owner, device_name: "agent", hides_private: true });
  const page = await t.query(api.sync.listThreads, { token: owner });
  const live = (page.rows as Row[]).filter((r) => !r.deleted && r.message_count > 0);
  expect(live.length).toBeGreaterThan(2);
  return { t, owner, agent, threads: live };
}

async function saveRules(t: T, token: string, rules: PrivacyRule[]) {
  await t.mutation(api.dispatch.dispatch, {
    token,
    action: "savePrivacyRules",
    args: [{}],
    patches: { client_state: { self: { privacy_rules: rules } } },
  });
}

/** What the judge would land: `hit` threads fall under the rule, the rest read clean. */
async function judge(t: T, threads: Row[], hit: Set<string>, rule = MEDICAL) {
  await t.mutation(internal.privacy.applyVerdicts, {
    accountId: threads[0].account_id,
    results: threads.map((th) => ({
      thread_gmail_id: th.gmail_id,
      message_count: th.message_count,
      checked: [ruleKey(rule)],
      hits: hit.has(th.gmail_id) ? [rule.id] : [],
      why: hit.has(th.gmail_id) ? "Lab results" : undefined,
    })),
  });
}

async function visibleIds(t: T, token: string): Promise<string[]> {
  const page = await t.query(api.sync.listThreads, { token });
  return (page.rows as Row[]).filter((r) => !r.deleted && r.message_count > 0).map((r) => r.gmail_id).sort();
}

describe("private mail", () => {
  test("with no rules and no marks, an agent sees what the person sees", async () => {
    const { t, owner, agent } = await setup();
    expect(await visibleIds(t, agent)).toEqual(await visibleIds(t, owner));
  });

  test("once rules exist, unread threads are hidden from agents until the judge has read them", async () => {
    const { t, owner, agent, threads } = await setup();
    await saveRules(t, owner, [MEDICAL]);
    expect(await visibleIds(t, agent)).toEqual([]);
    expect((await visibleIds(t, owner)).length).toBe(threads.length);
    const status = await t.query(api.privacy.status, { token: agent });
    expect(status).toEqual({ hides_private: true, hidden: threads.length, checking: threads.length });
  });

  test("a private thread does not exist for an agent, on every read path", async () => {
    const { t, owner, agent, threads } = await setup();
    await saveRules(t, owner, [MEDICAL]);
    const [secret, ...open] = threads;
    await judge(t, threads, new Set([secret.gmail_id]));

    expect(await visibleIds(t, agent)).toEqual(open.map((r) => r.gmail_id).sort());
    expect(await t.query(api.sync.threadsByIds, { token: agent, gmailIds: [secret.gmail_id] })).toEqual([]);
    expect(await t.query(api.sync.threadMessages, { token: agent, threadGmailId: secret.gmail_id })).toEqual([]);
    expect((await t.query(api.sync.threadMessages, { token: owner, threadGmailId: secret.gmail_id })).length).toBeGreaterThan(0);

    // A message id resolves to its thread, so it is hidden the same way.
    const [message] = await t.query(api.sync.threadMessages, { token: owner, threadGmailId: secret.gmail_id });
    expect(await t.query(api.sync.threadsByIds, { token: agent, gmailIds: [message.gmail_id] })).toEqual([]);

    const subject = (await t.query(api.sync.threadsByIds, { token: owner, gmailIds: [secret.gmail_id] }))[0].subject;
    const word = subject.split(/\s+/).find((w: string) => w.length > 3) ?? subject;
    const agentHits = await t.query(api.search.searchThreads, { token: agent, q: word });
    expect(agentHits.map((r: Row) => r.gmail_id)).not.toContain(secret.gmail_id);

    // Summaries and drafted replies read the thread for the caller.
    await expect(t.query(internal.ai.summarize.summaryContext, { token: agent, threadGmailId: secret.gmail_id })).rejects.toThrow("Thread not found");
    await expect(t.query(internal.ai.draft.contextForThread, { token: agent, threadGmailId: secret.gmail_id })).rejects.toThrow("Thread not found");
    await t.query(internal.ai.summarize.summaryContext, { token: owner, threadGmailId: secret.gmail_id });

    // An attachment download resolves nothing.
    expect(await t.query(internal.gmail.attachments.attachmentContext, { token: agent, viaHeader: true, messageGmailId: message.gmail_id })).toBeNull();

    const status = await t.query(api.privacy.status, { token: owner });
    expect(status).toMatchObject({ hides_private: false, private: 1, pending: 0, rules: [{ id: "p1", threads: 1 }] });
  });

  test("on the delta stream a thread that turns private reaches an agent as a bare tombstone", async () => {
    const { t, owner, agent, threads } = await setup();
    await saveRules(t, owner, [MEDICAL]);
    const since = (await t.query(api.sync.listThreads, { token: agent })).nextSince;
    await judge(t, threads, new Set([threads[0].gmail_id]));
    const delta = await t.query(api.sync.listThreads, { token: agent, since });
    const row = (delta.rows as Array<Row & { subject: string; participants: unknown[] }>).find((r) => r.gmail_id === threads[0].gmail_id)!;
    expect(row.deleted).toBe(true);
    expect(row.subject).toBe("");
    expect(row.participants).toEqual([]);
  });

  test("new mail on an open thread hides it again until it is read", async () => {
    const { t, owner, agent, threads } = await setup();
    await saveRules(t, owner, [MEDICAL]);
    await judge(t, threads, new Set());
    expect((await visibleIds(t, agent)).length).toBe(threads.length);
    await t.run(async (ctx) => {
      await ctx.db.patch(threads[0]._id as Id<"threads">, { message_count: threads[0].message_count + 1 });
    });
    expect(await visibleIds(t, agent)).not.toContain(threads[0].gmail_id);
  });

  test("a new rule hides only until it is read; a removed rule's hits stop counting", async () => {
    const { t, owner, agent, threads } = await setup();
    await saveRules(t, owner, [MEDICAL]);
    await judge(t, threads, new Set([threads[0].gmail_id]));
    const LEGAL: PrivacyRule = { id: "p2", text: "My lawyer", revision: 1, created_at: 2 };
    await saveRules(t, owner, [MEDICAL, LEGAL]);
    expect(await visibleIds(t, agent)).toEqual([]);
    await judge(t, threads, new Set(), LEGAL);
    expect((await visibleIds(t, agent)).length).toBe(threads.length - 1);
    await saveRules(t, owner, [LEGAL]);
    expect((await visibleIds(t, agent)).length).toBe(threads.length);
  });

  test("a verdict read under older wording, or before new mail, does not land", async () => {
    const { t, owner, agent, threads } = await setup();
    await saveRules(t, owner, [{ ...MEDICAL, revision: 2 }]);
    await judge(t, threads, new Set());
    expect(await visibleIds(t, agent)).toEqual([]);
    await t.mutation(internal.privacy.applyVerdicts, {
      accountId: threads[0].account_id,
      results: [{ thread_gmail_id: threads[0].gmail_id, message_count: threads[0].message_count + 5, checked: ["p1:2"], hits: [] }],
    });
    expect(await visibleIds(t, agent)).toEqual([]);
  });

  test("hand marks are final, and only the person can make them", async () => {
    const { t, owner, agent, threads } = await setup();
    await t.mutation(api.dispatch.dispatch, { token: owner, action: "setPrivate", args: [{ thread_gmail_ids: [threads[0].gmail_id], private: true }] });
    expect(await visibleIds(t, agent)).not.toContain(threads[0].gmail_id);
    await expect(
      t.mutation(api.dispatch.dispatch, { token: agent, action: "setPrivate", args: [{ thread_gmail_ids: [threads[1].gmail_id], private: false }] }),
    ).rejects.toThrow("Unauthorized");
    await saveRules(t, owner, [MEDICAL]);
    await judge(t, threads, new Set([threads[1].gmail_id]));
    await t.mutation(api.dispatch.dispatch, { token: owner, action: "setPrivate", args: [{ thread_gmail_ids: [threads[1].gmail_id], private: false }] });
    expect(await visibleIds(t, agent)).toContain(threads[1].gmail_id);
  });

  test("an agent cannot act on a private thread, or reply to or forward from one", async () => {
    const { t, owner, agent, threads } = await setup();
    await saveRules(t, owner, [MEDICAL]);
    const [secret, open] = threads;
    await judge(t, threads, new Set([secret.gmail_id]));
    const archive = (id: string) => ({ ops: [{ thread_gmail_ids: [id], remove_label_ids: ["INBOX"] }] });
    await expect(t.mutation(api.dispatch.dispatch, { token: agent, action: "applyThreadOps", args: [archive(secret.gmail_id)] })).rejects.toThrow("Thread not found");
    await t.mutation(api.dispatch.dispatch, { token: agent, action: "applyThreadOps", args: [archive(open.gmail_id)] });
    const [message] = await t.query(api.sync.threadMessages, { token: owner, threadGmailId: secret.gmail_id });
    await expect(
      t.mutation(api.dispatch.dispatch, {
        token: agent,
        action: "saveDraft",
        args: [{ client_id: "d1", to: [], cc: [], bcc: [], subject: "x", body_text: "x", mode: "reply", reply_to_gmail_id: message.gmail_id }],
      }),
    ).rejects.toThrow("Thread not found");
    await expect(
      t.mutation(api.dispatch.dispatch, {
        token: agent,
        action: "sendMessage",
        args: [{ client_id: "s1", to: [{ email: "x@example.com" }], subject: "fwd", body_text: "x", attachments: [{ filename: "a.pdf", mime_type: "application/pdf", size: 1, message_gmail_id: message.gmail_id, gmail_attachment_id: "a" }] }],
      }),
    ).rejects.toThrow("Thread not found");
  });

  test("an agent cannot loosen anything: rules, prefs, other logins, its own access", async () => {
    const { t, owner, agent } = await setup();
    await saveRules(t, owner, [MEDICAL]);
    await expect(saveRules(t, agent, [])).rejects.toThrow("Unauthorized");
    await expect(
      t.mutation(api.dispatch.dispatch, { token: agent, action: "setClientPref", args: [], patches: { client_state: { self: { privacy_rules: [] } } } }),
    ).rejects.toThrow("Unauthorized");
    await expect(t.mutation(api.devices.mint, { token: agent, device_name: "wider" })).rejects.toThrow("Unauthorized");
    const me = await t.query(api.devices.self, { token: agent });
    expect(me.hides_private).toBe(true);
    await expect(t.mutation(api.devices.setAccess, { token: agent, session_id: me._id, hides_private: false })).rejects.toThrow("Unauthorized");
    await expect(t.action(api.ai.privacy.previewPrivacy, { token: agent, text: "anything" })).rejects.toThrow("Unauthorized");
    // The rules themselves never reach it.
    const envelope = await t.query(api.sync.getAccount, { token: agent });
    expect(envelope.hides_private).toBe(true);
    expect((envelope.client_state?.prefs as Record<string, unknown>)?.privacy_rules).toBeUndefined();
    const own = await t.query(api.sync.getAccount, { token: owner });
    expect((own.client_state?.prefs as Record<string, unknown>)?.privacy_rules).toHaveLength(1);
  });

  test("a terminal can lock itself; only the person opens it again", async () => {
    const { t, owner, threads } = await setup();
    const { token: terminal } = await t.mutation(api.devices.mint, { token: owner, device_name: "laptop" });
    await t.mutation(api.dispatch.dispatch, { token: owner, action: "setPrivate", args: [{ thread_gmail_ids: [threads[0].gmail_id], private: true }] });
    expect(await visibleIds(t, terminal)).toContain(threads[0].gmail_id);
    await t.mutation(api.devices.lock, { token: terminal });
    expect(await visibleIds(t, terminal)).not.toContain(threads[0].gmail_id);
    const me = await t.query(api.devices.self, { token: terminal });
    await t.mutation(api.devices.setAccess, { token: owner, session_id: me._id, hides_private: false });
    expect(await visibleIds(t, terminal)).toContain(threads[0].gmail_id);
    const listed = await t.query(api.devices.list, { token: owner });
    expect(listed.find((d) => d._id === me._id)?.hides_private).toBe(false);
  });

  test("an agent login can sign itself out", async () => {
    const { t, agent } = await setup();
    const me = await t.query(api.devices.self, { token: agent });
    await t.mutation(api.devices.revoke, { token: agent, session_id: me._id });
    await expect(t.query(api.sync.listThreads, { token: agent })).rejects.toThrow("Unauthorized");
  });

  test("an agent's filter never acts on private mail", async () => {
    const { t, owner, agent, threads } = await setup();
    await saveRules(t, owner, [MEDICAL]);
    const [secret, open] = threads;
    await judge(t, threads, new Set([secret.gmail_id]));
    const saved = await t.mutation(api.dispatch.dispatch, {
      token: agent,
      action: "saveFilter",
      args: [{ text: "star all", condition: "every thread", actions: [{ kind: "star" }] }],
    });
    const hits = [secret, open].map((th) => ({ filter_id: saved.filter_id, thread_gmail_id: th.gmail_id, revision: 0, message_count: th.message_count, last_at: 0, inbound_at: 0 }));
    for (const th of [secret, open]) {
      const row = (await t.query(api.sync.threadsByIds, { token: owner, gmailIds: [th.gmail_id] }))[0];
      hits.find((h) => h.thread_gmail_id === th.gmail_id)!.last_at = row.last_at;
    }
    const { applied } = await t.mutation(internal.filters.applyHits, { accountId: secret.account_id, includeOlder: true, hits });
    expect(applied).toBe(1);
  });
});

describe("private mail, the edges", () => {
  test("a hit is sticky: new mail on a private thread never opens it by itself", async () => {
    const { t, owner, agent, threads } = await setup();
    await saveRules(t, owner, [MEDICAL]);
    const [secret] = threads;
    await judge(t, threads, new Set([secret.gmail_id]));
    const grown = secret.message_count + 1;
    await t.run(async (ctx) => {
      await ctx.db.patch(secret._id as Id<"threads">, { message_count: grown });
    });
    // The judge, reading only the newest messages, finds nothing now.
    await t.mutation(internal.privacy.applyVerdicts, {
      accountId: secret.account_id,
      results: [{ thread_gmail_id: secret.gmail_id, message_count: grown, checked: [ruleKey(MEDICAL)], hits: [] }],
    });
    expect(await visibleIds(t, agent)).not.toContain(secret.gmail_id);
    // Rewording the rule reads it afresh.
    const reworded = { ...MEDICAL, revision: 2 };
    await saveRules(t, owner, [reworded]);
    await t.mutation(internal.privacy.applyVerdicts, {
      accountId: secret.account_id,
      results: [{ thread_gmail_id: secret.gmail_id, message_count: grown, checked: [ruleKey(reworded)], hits: [] }],
    });
    expect(await visibleIds(t, agent)).toContain(secret.gmail_id);
  });

  test("a thread opened by hand reaches an agent without the model's reason", async () => {
    const { t, owner, agent, threads } = await setup();
    await saveRules(t, owner, [MEDICAL]);
    await judge(t, threads, new Set([threads[0].gmail_id]));
    await t.mutation(api.dispatch.dispatch, { token: owner, action: "setPrivate", args: [{ thread_gmail_ids: [threads[0].gmail_id], private: false }] });
    const [row] = await t.query(api.sync.threadsByIds, { token: agent, gmailIds: [threads[0].gmail_id] });
    expect(row.private_why).toBeUndefined();
    expect(row.private_hits).toBeUndefined();
    const [own] = await t.query(api.sync.threadsByIds, { token: owner, gmailIds: [threads[0].gmail_id] });
    expect(own.private_why).toBe("Lab results");
  });

  test("an agent gets voice and preferences from memory, nothing about people", async () => {
    const { t, owner, agent, threads } = await setup();
    await t.run(async (ctx) => {
      for (const kind of ["style", "preference", "contact", "rule"] as const) {
        await ctx.db.insert("memories", { account_id: threads[0].account_id, kind, text: kind, source: "manual", created_at: 1, updated_at: 1 } as any);
      }
    });
    const kinds = (rows: Array<{ kind: string }>) => [...new Set(rows.map((m) => m.kind))].sort();
    expect(kinds(await t.query(api.memories.listMemories, { token: agent }))).toEqual(["preference", "style"]);
    expect(kinds(await t.query(api.memories.listMemories, { token: owner }))).toEqual(["contact", "preference", "rule", "style"]);
  });

  test("a topic made only of private mail does not exist for an agent, removed or not", async () => {
    const { t, owner, agent, threads } = await setup();
    const [secret, open] = threads;
    const { clusterId, goneId } = await t.run(async (ctx) => {
      const base = { account_id: secret.account_id, description: "about it", hue: 1, source: "user" as const, created_at: 1, updated_at: 1 };
      const clusterId = await ctx.db.insert("clusters", { ...base, name: "Oncology" } as any);
      const goneId = await ctx.db.insert("clusters", { ...base, name: "Divorce", deleted: true } as any);
      await ctx.db.patch(secret._id as Id<"threads">, { cluster_id: clusterId });
      return { clusterId, goneId };
    });
    await t.mutation(api.dispatch.dispatch, { token: owner, action: "setPrivate", args: [{ thread_gmail_ids: [secret.gmail_id], private: true }] });
    const rows = await t.query(api.clusters.listClusters, { token: agent });
    expect(rows.find((c) => c._id === clusterId)).toBeUndefined();
    expect(rows.find((c) => c._id === goneId)?.name).toBe("");
    await expect(
      t.mutation(api.dispatch.dispatch, { token: agent, action: "setThreadCluster", args: [{ thread_gmail_ids: [open.gmail_id], cluster_id: clusterId }] }),
    ).rejects.toThrow("Topic not found");
    await expect(
      t.mutation(api.dispatch.dispatch, { token: agent, action: "createCluster", args: [{ name: "oncology", thread_gmail_ids: [open.gmail_id] }] }),
    ).rejects.toThrow("Choose another name");
  });
});

describe("the privacy judge's answers", () => {
  test("a complete answer parses; a stray or missing id rejects the batch", () => {
    expect(parsePrivacyVerdict({ t0: { rules: ["r0"], why: "Lab work" }, t1: { rules: [] } }, 2, 1)).toEqual([
      { rules: [0], why: "Lab work" },
      { rules: [], why: undefined },
    ]);
    expect(() => parsePrivacyVerdict({ t0: { rules: ["r3"] } }, 1, 1)).toThrow();
    expect(() => parsePrivacyVerdict({ t0: { rules: [] } }, 2, 1)).toThrow();
    expect(() => parsePrivacyVerdict("nope", 1, 1)).toThrow();
  });

  test("every mail reference a dispatch payload can carry is collected", () => {
    const refs = payloadMailRefs({
      account_id: "a",
      thread_gmail_id: "t1",
      thread_gmail_ids: ["t2"],
      reply_to_gmail_id: "m1",
      attachments: [{ message_gmail_id: "m2" }],
      ops: [{ account_id: "b", thread_gmail_ids: ["t3"] }],
    });
    expect(refs).toEqual([
      { account_id: "a", id: "t1" },
      { account_id: "a", id: "t2" },
      { account_id: "a", id: "m1" },
      { account_id: "a", id: "m2" },
      { account_id: "b", id: "t3" },
    ]);
  });
});
