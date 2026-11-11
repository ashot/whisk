import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { lensInput, parseLensVerdict } from "./ai/lenses";
import { DEFAULT_IMPORTANCE_POLICY, IMPORTANT } from "@mail/shared/src/lib/lenses";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./demo.ts": () => import("./demo"),
  "./dispatch.ts": () => import("./dispatch"),
  "./lenses.ts": () => import("./lenses"),
  "./migrations.ts": () => import("./migrations"),
  "./sync.ts": () => import("./sync"),
};

type Harness = ReturnType<typeof convexTest>;

async function seeded() {
  const t = convexTest(schema, modules);
  const { token, accountId } = await t.mutation(api.demo.seed, {});
  return { t, token, accountId };
}

const thread = (t: Harness, gmailId: string) =>
  t.run(async (ctx) => (await ctx.db.query("threads").collect()).find((r) => r.gmail_id === gmailId) as Doc<"threads">);

const dispatch = (t: Harness, token: string, action: string, args: unknown, patches?: unknown) =>
  t.mutation(api.dispatch.dispatch, { token, action, args, patches });

const KIDS = { id: "kids", name: "Kids", policy: "School and childcare", cutoff: 50, revision: 1 };
const withLenses = (lenses: unknown[]) => ({ client_state: { singleton: { lenses } } });

const DEBATE = "demo-thread-02";

describe("lens scores", () => {
  test("scores land per lens, a stale lens's scores are dropped, and removed lenses fall away", async () => {
    const { t, token, accountId } = await seeded();
    await dispatch(t, token, "saveLens", [{ id: "kids" }], withLenses([KIDS]));
    const row = await thread(t, DEBATE);
    const result = (scores: Record<string, { score: number; why: string }>) => ({ thread_gmail_id: DEBATE, message_count: row.message_count, last_at: row.last_at, scores });

    await t.mutation(internal.lenses.applyScores, {
      accountId,
      revisions: { [IMPORTANT]: 0, kids: 0 },
      results: [result({ [IMPORTANT]: { score: 20, why: "Team chatter" }, kids: { score: 90, why: "School" } })],
    });
    // Kids was read under revision 0 but stands at 1: only Important lands.
    expect((await thread(t, DEBATE)).lens_scores).toEqual({ [IMPORTANT]: 20 });

    await t.mutation(internal.lenses.applyScores, { accountId, revisions: { kids: 1 }, results: [result({ kids: { score: 90, why: "School" } })] });
    expect((await thread(t, DEBATE)).lens_scores).toEqual({ [IMPORTANT]: 20, kids: 90 });

    await dispatch(t, token, "setClientPref", [], withLenses([]));
    await t.mutation(internal.lenses.applyScores, { accountId, revisions: { [IMPORTANT]: 0 }, results: [result({ [IMPORTANT]: { score: 25, why: "x" } })] });
    expect((await thread(t, DEBATE)).lens_scores).toEqual({ [IMPORTANT]: 25 });
  });

  test("a hand placement is final, becomes a correction, and null hands it back", async () => {
    const { t, token, accountId } = await seeded();
    await dispatch(t, token, "setLensMark", [{ thread_gmail_ids: [DEBATE], lens_id: IMPORTANT, belongs: false, account_id: accountId }]);
    let row = await thread(t, DEBATE);
    expect(row.lens_marks).toEqual({ [IMPORTANT]: false });
    expect(row.marked_at).toBeGreaterThan(0);

    const context = await t.query(internal.lenses.judgeContext, { accountId });
    expect(context.lenses.map((l) => l.id)).toEqual([IMPORTANT]);
    expect(context.lenses[0].policy).toBe(DEFAULT_IMPORTANCE_POLICY);
    expect(context.corrections).toEqual([expect.objectContaining({ lens: IMPORTANT, belongs: false })]);

    await dispatch(t, token, "setLensMark", [{ thread_gmail_ids: [DEBATE], lens_id: IMPORTANT, belongs: null, account_id: accountId }]);
    row = await thread(t, DEBATE);
    expect(row.lens_marks).toBeUndefined();
    expect(row.marked_at).toBeUndefined();
  });

  test("the migration moves the importance fields into the lens maps", async () => {
    const { t } = await seeded();
    await t.run(async (ctx) => {
      const rows = (await ctx.db.query("threads").collect()).slice(0, 2);
      await ctx.db.patch(rows[0]._id, { important: false, important_by: "ai", important_why: "Newsletter" });
      await ctx.db.patch(rows[1]._id, { important: true, important_by: "user" });
    });
    await t.mutation(internal.migrations.lensesFromImportance, {});
    const rows = (await t.run(async (ctx) => await ctx.db.query("threads").collect())).slice(0, 2);
    expect(rows[0]).toMatchObject({ lens_scores: { [IMPORTANT]: 20 }, lens_why: { [IMPORTANT]: "Newsletter" } });
    expect(rows[1]).toMatchObject({ lens_marks: { [IMPORTANT]: true } });
    for (const r of rows) expect([r.important, r.important_by, r.important_why]).toEqual([undefined, undefined, undefined]);
  });
});

describe("re-scoring after hand placements", () => {
  test("placements book one whole-inbox pass, pushed back by each new one; placements during a pass book the next", async () => {
    const { t, token, accountId } = await seeded();
    // Jobs book but never fire: no model call, and nothing lands in the next file.
    const realTimeout = globalThis.setTimeout;
    const realKey = process.env.ANTHROPIC_API_KEY;
    globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
    process.env.ANTHROPIC_API_KEY = "test";
    try {
      const account = () => t.run(async (ctx) => (await ctx.db.get(accountId))!);
      const job = (id: Doc<"accounts">["lens_job"]) => t.run(async (ctx) => (id ? await ctx.db.system.get(id) : null));
      const mark = (lens_id: string) => dispatch(t, token, "setLensMark", [{ thread_gmail_ids: [DEBATE], lens_id, belongs: true, account_id: accountId }]);

      await mark(IMPORTANT);
      const first = await account();
      expect(first.lens_pending).toEqual([IMPORTANT]);
      expect((await job(first.lens_job))?.state.kind).toBe("pending");

      await mark("kids");
      const second = await account();
      expect(second.lens_pending).toEqual([IMPORTANT, "kids"]);
      expect(second.lens_job).not.toBe(first.lens_job);
      expect((await job(first.lens_job))?.state.kind).toBe("canceled");

      expect(await t.mutation(internal.lenses.startRescore, { accountId })).toEqual([IMPORTANT, "kids"]);
      expect((await account()).lens_pending).toBeUndefined();
      await t.mutation(internal.lenses.finishRescore, { accountId });
      expect((await account()).lens_job).toBeUndefined();

      await mark("kids");
      await t.mutation(internal.lenses.startRescore, { accountId });
      await mark(IMPORTANT);
      await t.mutation(internal.lenses.finishRescore, { accountId });
      const after = await account();
      expect(after.lens_pending).toEqual([IMPORTANT]);
      expect((await job(after.lens_job))?.state.kind).toBe("pending");
    } finally {
      globalThis.setTimeout = realTimeout;
      if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = realKey;
    }
  });
});

describe("the lens judge's input and verdict", () => {
  test("lens ids are renamed for the model and mapped back", () => {
    const input = JSON.parse(lensInput({ owner: "me@x.org", lenses: [{ id: IMPORTANT, name: "Important", policy: "p" }, { id: "kids", name: "Kids", policy: "k" }], corrections: [{ from: "a", subject: "s", lens: "kids", belongs: true }], rows: [] }));
    expect(input.lists.map((l: { id: string }) => l.id)).toEqual(["l0", "l1"]);
    expect(input.corrections[0].list).toBe("l1");
    expect(parseLensVerdict({ t0: { l0: [85, "Ada asks"], l1: [140, "x"] } }, 1, [IMPORTANT, "kids"])).toEqual([{ [IMPORTANT]: { score: 85, why: "Ada asks" }, kids: { score: 100, why: "x" } }]);
    expect(() => parseLensVerdict({ t0: { l0: [85, "x"] } }, 1, [IMPORTANT, "kids"])).toThrow(/Incomplete/);
    expect(() => parseLensVerdict(null, 1, [IMPORTANT])).toThrow(/Invalid/);
  });
});
