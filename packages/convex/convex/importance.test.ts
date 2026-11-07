import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { parseImportanceVerdict } from "./ai/importance";
import { DEFAULT_IMPORTANCE_POLICY } from "@mail/shared/src/lib/importance";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./demo.ts": () => import("./demo"),
  "./dispatch.ts": () => import("./dispatch"),
  "./importance.ts": () => import("./importance"),
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

const DEBATE = "demo-thread-02";

describe("importance verdicts", () => {
  test("a verdict lands, and a hand mark is final against the model", async () => {
    const { t, token, accountId } = await seeded();
    const before = await thread(t, DEBATE);
    const verdict = { thread_gmail_id: DEBATE, important: false, why: "Team chatter", message_count: before.message_count, last_at: before.last_at };
    await t.mutation(internal.importance.applyImportance, { accountId, revision: 0, verdicts: [verdict] });
    expect(await thread(t, DEBATE)).toMatchObject({ important: false, important_by: "ai", important_why: "Team chatter" });

    await dispatch(t, token, "setImportance", [{ thread_gmail_ids: [DEBATE], important: true, account_id: accountId }]);
    expect(await thread(t, DEBATE)).toMatchObject({ important: true, important_by: "user" });

    await t.mutation(internal.importance.applyImportance, { accountId, revision: 0, verdicts: [verdict] });
    expect((await thread(t, DEBATE)).important).toBe(true);

    // Handing it back clears the mark so the model judges it again.
    await dispatch(t, token, "setImportance", [{ thread_gmail_ids: [DEBATE], important: null, account_id: accountId }]);
    const back = await thread(t, DEBATE);
    expect(back.important).toBeUndefined();
    expect(back.important_by).toBeUndefined();
  });

  test("a verdict read under an older policy, or from an older thread, is dropped", async () => {
    const { t, token, accountId } = await seeded();
    const before = await thread(t, DEBATE);
    await dispatch(t, token, "setImportancePolicy", [{ policy: "Only my sister" }], {
      client_state: { singleton: { importance: { policy: "Only my sister", revision: 1 } } },
    });
    const stale = { thread_gmail_id: DEBATE, important: false, why: "x", message_count: before.message_count, last_at: before.last_at };
    await t.mutation(internal.importance.applyImportance, { accountId, revision: 0, verdicts: [stale] });
    expect((await thread(t, DEBATE)).important).toBeUndefined();

    await t.mutation(internal.importance.applyImportance, { accountId, revision: 1, verdicts: [{ ...stale, message_count: before.message_count - 1 }] });
    expect((await thread(t, DEBATE)).important).toBeUndefined();

    await t.mutation(internal.importance.applyImportance, { accountId, revision: 1, verdicts: [stale] });
    expect((await thread(t, DEBATE)).important).toBe(false);
  });

  test("the judge reads the saved policy and the person's marks", async () => {
    const { t, token, accountId } = await seeded();
    let context = await t.query(internal.importance.judgeContext, { accountId });
    expect(context.policy).toBe(DEFAULT_IMPORTANCE_POLICY);
    expect(context.corrections).toEqual([]);

    await dispatch(t, token, "setImportancePolicy", [{ policy: "Only my sister" }], {
      client_state: { singleton: { importance: { policy: "Only my sister", revision: 3 } } },
    });
    await dispatch(t, token, "setImportance", [{ thread_gmail_ids: [DEBATE], important: false, account_id: accountId }]);
    context = await t.query(internal.importance.judgeContext, { accountId });
    expect(context.policy).toBe("Only my sister");
    expect(context.revision).toBe(3);
    expect(context.corrections).toHaveLength(1);
    expect(context.corrections[0].important).toBe(false);
  });
});

describe("parseImportanceVerdict", () => {
  test("every thread must be answered with a boolean", () => {
    expect(parseImportanceVerdict({ t0: { important: true, why: "Ada asks about Thursday" } }, 1)).toEqual([{ important: true, why: "Ada asks about Thursday" }]);
    expect(() => parseImportanceVerdict({ t0: { important: true } }, 2)).toThrow(/Incomplete/);
    expect(() => parseImportanceVerdict({ t0: { important: "yes" } }, 1)).toThrow(/Incomplete/);
    expect(() => parseImportanceVerdict(null, 1)).toThrow(/Invalid/);
  });
});
