import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";

// Lanes, rules, reminders and the classification write path — the server half
// of the whisk AI layer. Model calls never run here (no API key in tests);
// everything below is the deterministic machinery around them.

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./auth.ts": () => import("./auth"),
  "./demo.ts": () => import("./demo"),
  "./dispatch.ts": () => import("./dispatch"),
  "./search.ts": () => import("./search"),
  "./sync.ts": () => import("./sync"),
  "./memories.ts": () => import("./memories"),
  "./reminders.ts": () => import("./reminders"),
  "./ai/classify.ts": () => import("./ai/classify"),
  "./gmail/pump.ts": () => import("./gmail/pump"),
  "./gmail/sync.ts": () => import("./gmail/sync"),
  "./gmail/oauth.ts": () => import("./gmail/oauth"),
  "./migrations.ts": () => import("./migrations"),
};

type Harness = ReturnType<typeof convexTest>;

async function seeded() {
  const t = convexTest(schema, modules);
  const { token, accountId } = await t.mutation(api.demo.seed, {});
  return { t, token, accountId: accountId as Id<"accounts"> };
}

const rowsOf = <T extends keyof typeof schema.tables>(t: Harness, table: T) =>
  t.run(async (ctx) => await ctx.db.query(table).collect());

const threads = async (t: Harness) =>
  (await rowsOf(t, "threads")) as Doc<"threads">[];

const dispatch = (t: Harness, token: string, action: string, args: unknown) =>
  t.mutation(api.dispatch.dispatch, { token, action, args });

/** The demo thread started by this sender (participants[0]). */
async function threadStartedBy(t: Harness, email: string) {
  const all = await threads(t);
  const hit = all.find((row) => row.participants[0]?.email === email);
  expect(hit).toBeDefined();
  return hit!;
}

describe("demo classification", () => {
  test("machine senders arrive pre-filed; humans stay primary", async () => {
    const { t } = await seeded();
    const all = await threads(t);
    const byStarter = (email: string) =>
      all.find((row) => row.participants[0]?.email === email);
    expect(byStarter("notifications@github.com")?.category).toBe("notifications");
    expect(byStarter("dispatch@overcastweekly.com")?.category).toBe("newsletters");
    expect(byStarter("itinerary@aerialairways.com")?.category).toBe("travel");
    // A colleague's thread carries no lane at all.
    expect(byStarter("theo@driftwork.io")?.category).toBeUndefined();
  });

  test("memories and live reminders are part of the first-run mailbox", async () => {
    const { t } = await seeded();
    const memories = (await rowsOf(t, "memories")) as Doc<"memories">[];
    expect(memories.filter((m) => m.kind === "style").length).toBeGreaterThanOrEqual(3);
    expect(memories.some((m) => m.kind === "rule")).toBe(true);
    const reminders = (await rowsOf(t, "reminders")) as Doc<"reminders">[];
    const armed = reminders.filter((r) => r.status === "armed");
    expect(armed.map((r) => r.kind).sort()).toEqual(["followup", "snooze"]);
  });
});

describe("setCategory", () => {
  test("filing is final for the thread and teaches a sender rule", async () => {
    const { t, token } = await seeded();
    const digest = await threadStartedBy(t, "delphine@driftwork.io");
    await dispatch(t, token, "setCategory", {
      thread_gmail_ids: [digest.gmail_id],
      category: "notifications",
    });
    const after = await threads(t);
    const refiled = after.find((row) => row._id === digest._id)!;
    expect(refiled.category).toBe("notifications");
    expect(refiled.category_source).toBe("user");
    const rules = ((await rowsOf(t, "memories")) as Doc<"memories">[]).filter(
      (m) => m.kind === "rule" && m.contact_email === "delphine@driftwork.io",
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].category).toBe("notifications");
  });

  test("the rule sweep moves only threads the sender STARTED", async () => {
    const { t, token } = await seeded();
    const digest = await threadStartedBy(t, "delphine@driftwork.io");
    await dispatch(t, token, "setCategory", {
      thread_gmail_ids: [digest.gmail_id],
      category: "notifications",
    });
    const after = await threads(t);
    // Delphine appears in other people's threads (the postgres upgrade thread
    // is Theo's); a rule about her mail must not drag those along.
    for (const row of after) {
      const starter = row.participants[0]?.email;
      const involved = row.participants.some(
        (p) => p.email === "delphine@driftwork.io",
      );
      if (involved && starter !== "delphine@driftwork.io") {
        expect(row.category_source ?? "unset").not.toBe("rule");
      }
    }
  });

  test("filing back to primary clears the lane and remembers that too", async () => {
    const { t, token } = await seeded();
    const overcast = await threadStartedBy(t, "dispatch@overcastweekly.com");
    expect(overcast.category).toBe("newsletters");
    await dispatch(t, token, "setCategory", {
      thread_gmail_ids: [overcast.gmail_id],
      category: null,
    });
    const after = await threadStartedBy(t, "dispatch@overcastweekly.com");
    expect(after.category).toBeUndefined();
    expect(after.category_source).toBe("user");
  });

  test("a made-up category is refused", async () => {
    const { t, token } = await seeded();
    const digest = await threadStartedBy(t, "delphine@driftwork.io");
    await expect(
      dispatch(t, token, "setCategory", {
        thread_gmail_ids: [digest.gmail_id],
        category: "definitely-not-a-lane",
      }),
    ).rejects.toThrow(/Unknown category/);
  });
});

describe("model classification write path", () => {
  test("an ai verdict lands, but never over a human's word", async () => {
    const { t, token, accountId } = await seeded();
    const theo = await threadStartedBy(t, "theo@driftwork.io");
    // The model files it (wrongly) as promotions.
    await t.mutation(internal.ai.classify.applyCategories, {
      accountId,
      entries: [{ thread_gmail_id: theo.gmail_id, category: "promotions" }],
    });
    let after = await threadStartedBy(t, "theo@driftwork.io");
    expect(after.category).toBe("promotions");
    expect(after.category_source).toBe("ai");
    // The human corrects it; a later model pass must not undo that.
    await dispatch(t, token, "setCategory", {
      thread_gmail_ids: [theo.gmail_id],
      category: null,
    });
    await t.mutation(internal.ai.classify.applyCategories, {
      accountId,
      entries: [{ thread_gmail_id: theo.gmail_id, category: "promotions" }],
    });
    after = await threadStartedBy(t, "theo@driftwork.io");
    expect(after.category).toBeUndefined();
    expect(after.category_source).toBe("user");
  });

  test("a hallucinated lane id is recorded as primary, not written raw", async () => {
    const { t, accountId } = await seeded();
    const theo = await threadStartedBy(t, "theo@driftwork.io");
    await t.mutation(internal.ai.classify.applyCategories, {
      accountId,
      entries: [{ thread_gmail_id: theo.gmail_id, category: "spam-o-tron" }],
    });
    const after = await threadStartedBy(t, "theo@driftwork.io");
    expect(after.category).toBeUndefined();
    expect(after.category_source).toBe("ai");
  });

  test("settled threads are excluded from the classification batch", async () => {
    const { t, token, accountId } = await seeded();
    const theo = await threadStartedBy(t, "theo@driftwork.io");
    const github = await threadStartedBy(t, "notifications@github.com");
    await dispatch(t, token, "setCategory", {
      thread_gmail_ids: [theo.gmail_id],
      category: "notifications",
    });
    const batch = await t.query(internal.ai.classify.threadsForClassification, {
      accountId,
      threadGmailIds: [theo.gmail_id, github.gmail_id],
    });
    // theo: user-filed; github: heuristic-filed at seed — both settled.
    expect(batch).toHaveLength(0);
  });
});

describe("reminders", () => {
  test("snooze leaves the inbox now and mirrors the archive to Gmail", async () => {
    const { t, token } = await seeded();
    const hannah = await threadStartedBy(t, "h.vogel@brightpathsearch.com");
    expect(hannah.label_ids).toContain("INBOX");
    await dispatch(t, token, "setReminder", {
      thread_gmail_id: hannah.gmail_id,
      kind: "snooze",
      remind_at: Date.now() + 60 * 60 * 1000,
    });
    const after = await threadStartedBy(t, "h.vogel@brightpathsearch.com");
    expect(after.label_ids).not.toContain("INBOX");
    const outbound = (await rowsOf(t, "outbound")) as Doc<"outbound">[];
    const modify = outbound.find(
      (o) =>
        o.kind === "modify" &&
        (o.payload as any).thread_gmail_ids?.includes(hannah.gmail_id) &&
        (o.payload as any).remove_label_ids?.includes("INBOX"),
    );
    expect(modify).toBeDefined();
  });

  test("re-arming replaces the previous reminder instead of stacking", async () => {
    const { t, token } = await seeded();
    const hannah = await threadStartedBy(t, "h.vogel@brightpathsearch.com");
    for (const offset of [1, 2]) {
      await dispatch(t, token, "setReminder", {
        thread_gmail_id: hannah.gmail_id,
        kind: "snooze",
        remind_at: Date.now() + offset * 60 * 60 * 1000,
      });
    }
    const reminders = ((await rowsOf(t, "reminders")) as Doc<"reminders">[]).filter(
      (r) => r.thread_gmail_id === hannah.gmail_id,
    );
    expect(reminders.filter((r) => r.status === "armed")).toHaveLength(1);
    expect(reminders.filter((r) => r.status === "canceled")).toHaveLength(1);
  });

  test("cancel restores the inbox for an armed snooze", async () => {
    const { t, token } = await seeded();
    const hannah = await threadStartedBy(t, "h.vogel@brightpathsearch.com");
    await dispatch(t, token, "setReminder", {
      thread_gmail_id: hannah.gmail_id,
      kind: "snooze",
      remind_at: Date.now() + 60 * 60 * 1000,
    });
    await dispatch(t, token, "cancelReminder", {
      thread_gmail_id: hannah.gmail_id,
    });
    const after = await threadStartedBy(t, "h.vogel@brightpathsearch.com");
    expect(after.label_ids).toContain("INBOX");
    const reminders = ((await rowsOf(t, "reminders")) as Doc<"reminders">[]).filter(
      (r) => r.thread_gmail_id === hannah.gmail_id && r.kind === "snooze",
    );
    expect(reminders.every((r) => r.status === "canceled")).toBe(true);
  });

  test("a due snooze fires back into the inbox, unread", async () => {
    const { t, token, accountId } = await seeded();
    const hannah = await threadStartedBy(t, "h.vogel@brightpathsearch.com");
    await dispatch(t, token, "setReminder", {
      thread_gmail_id: hannah.gmail_id,
      kind: "snooze",
      remind_at: Date.now() + 60 * 60 * 1000,
    });
    // Time travel: pull the reminder into the past, then tick the clock.
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("reminders").collect();
      for (const row of rows) {
        if (row.thread_gmail_id === hannah.gmail_id && row.status === "armed") {
          await ctx.db.patch(row._id, { remind_at: Date.now() - 1000 });
        }
      }
    });
    await t.mutation(internal.reminders.fireDue, {});
    const after = await threadStartedBy(t, "h.vogel@brightpathsearch.com");
    expect(after.label_ids).toContain("INBOX");
    expect(after.is_unread).toBe(true);
    const fired = ((await rowsOf(t, "reminders")) as Doc<"reminders">[]).find(
      (r) => r.thread_gmail_id === hannah.gmail_id && r.status === "fired",
    );
    expect(fired).toBeDefined();
    void accountId;
  });

  test("a follow-up watch satisfied by a reply resolves silently", async () => {
    const { t, token } = await seeded();
    const hannah = await threadStartedBy(t, "h.vogel@brightpathsearch.com");
    await dispatch(t, token, "setReminder", {
      thread_gmail_id: hannah.gmail_id,
      kind: "followup",
      remind_at: Date.now() + 60 * 60 * 1000,
    });
    // A reply lands after arming (the thread's last_at moves forward), then
    // the watch comes due.
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("reminders").collect();
      for (const row of rows) {
        if (row.thread_gmail_id === hannah.gmail_id && row.status === "armed") {
          await ctx.db.patch(row._id, {
            remind_at: Date.now() - 1000,
            baseline_last_at: hannah.last_at - 1,
          });
        }
      }
    });
    const labelsBefore = (await threadStartedBy(t, "h.vogel@brightpathsearch.com"))
      .label_ids;
    await t.mutation(internal.reminders.fireDue, {});
    const after = await threadStartedBy(t, "h.vogel@brightpathsearch.com");
    expect(after.label_ids).toEqual(labelsBefore); // nothing surfaced
    const resolved = ((await rowsOf(t, "reminders")) as Doc<"reminders">[]).find(
      (r) => r.thread_gmail_id === hannah.gmail_id && r.kind === "followup",
    );
    expect(resolved?.status).toBe("resolved");
  });
});

describe("memories", () => {
  test("addMemory and deleteMemory round-trip through dispatch", async () => {
    const { t, token } = await seeded();
    const { memory_id } = await dispatch(t, token, "addMemory", {
      text: "Prefers plain text over HTML",
    });
    let memories = (await rowsOf(t, "memories")) as Doc<"memories">[];
    const added = memories.find((m) => m._id === memory_id);
    expect(added?.kind).toBe("preference");
    expect(added?.source).toBe("manual");
    await dispatch(t, token, "deleteMemory", { memory_id });
    memories = (await rowsOf(t, "memories")) as Doc<"memories">[];
    expect(memories.find((m) => m._id === memory_id)?.deleted).toBe(true);
  });

  test("a stranger's token cannot delete my memory", async () => {
    const { t, token, accountId } = await seeded();
    const other = await t.mutation(api.demo.seed, {});
    const memories = (await rowsOf(t, "memories")) as Doc<"memories">[];
    const mine = memories.find(
      (m) => m.kind === "rule" && m.account_id === accountId,
    )!;
    await expect(
      dispatch(t, other.token!, "deleteMemory", { memory_id: mine._id }),
    ).rejects.toThrow(/Unauthorized/);
    void token;
  });
});
