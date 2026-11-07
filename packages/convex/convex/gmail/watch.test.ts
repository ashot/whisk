import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../schema";
import { internal } from "../_generated/api";

// Google posts a mailbox change to /gmail/push; the receiver checks the URL
// token and queues one incremental sync for that mailbox, and only one.

const modules = {
  "./_generated/api.js": () => import("../_generated/api.js"),
  "./_generated/server.js": () => import("../_generated/server.js"),
  "./http.ts": () => import("../http"),
  "./gmail/watch.ts": () => import("./watch"),
  "./gmail/sync.ts": () => import("./sync"),
};

const EMAIL = "nora@driftwork.io";

// A queued sync would run after the test and write into a closed harness.
const active: ReturnType<typeof convexTest>[] = [];
afterEach(async () => {
  for (const t of active.splice(0)) {
    await t.run(async (ctx) => {
      const jobs = await ctx.db.system.query("_scheduled_functions").collect();
      for (const job of jobs) if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
});

async function mailbox(over: Record<string, unknown> = {}) {
  const t = convexTest(schema, modules);
  active.push(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("accounts", {
      email: EMAIL,
      provider: "gmail" as const,
      sync_status: "idle" as const,
      history_id: "100",
      updated_at: Date.now(),
      ...over,
    });
  });
  return t;
}

const pendingSyncs = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((j) => j.state.kind === "pending" && /sync(\.js)?:incremental$/.test(j.name));
  });

const push = (t: ReturnType<typeof convexTest>, token: string, change: unknown) =>
  t.fetch(`/gmail/push?token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: { data: btoa(JSON.stringify(change)), messageId: "1" }, subscription: "s" }),
  });

let savedToken: string | undefined;
beforeEach(() => {
  savedToken = process.env.GMAIL_PUSH_TOKEN;
  process.env.GMAIL_PUSH_TOKEN = "secret";
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.GMAIL_PUSH_TOKEN;
  else process.env.GMAIL_PUSH_TOKEN = savedToken;
});

test("a change newer than the cursor queues one sync; a burst queues no more; old news queues none", async () => {
  const t = await mailbox();
  expect(await t.mutation(internal.gmail.watch.noteChange, { email: EMAIL, historyId: "100" })).toEqual({ scheduled: false });
  expect(await t.mutation(internal.gmail.watch.noteChange, { email: EMAIL, historyId: "101" })).toEqual({ scheduled: true });
  expect(await t.mutation(internal.gmail.watch.noteChange, { email: EMAIL, historyId: "102" })).toEqual({ scheduled: false });
  expect(await pendingSyncs(t)).toHaveLength(1);
  expect(await t.mutation(internal.gmail.watch.noteChange, { email: "nobody@driftwork.io", historyId: "101" })).toEqual({ scheduled: false });
});

test("the receiver takes the token on the URL as its whole check and answers Google with a 2xx either way", async () => {
  const t = await mailbox();
  expect((await push(t, "wrong", { emailAddress: EMAIL, historyId: 101 })).status).toBe(403);
  expect(await pendingSyncs(t)).toHaveLength(0);
  expect((await push(t, "secret", { emailAddress: EMAIL, historyId: 101 })).status).toBe(204);
  expect(await pendingSyncs(t)).toHaveLength(1);
  expect((await push(t, "secret", "not a change")).status).toBe(204);
  delete process.env.GMAIL_PUSH_TOKEN;
  expect((await push(t, "secret", { emailAddress: EMAIL, historyId: 105 })).status).toBe(503);
});
