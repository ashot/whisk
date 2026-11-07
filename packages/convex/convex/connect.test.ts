import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { createAuthSession, hashToken } from "./lib/auth";
import { isAllowedReturnUrl, connectedApp, returnWith } from "./lib/apps";
import { encryptAESGCMString } from "@platform/crypto/aes";
import { isSealed, openCredential, resealLegacyCredential, sealCredential } from "./lib/credentials";
import { DISPATCH_SCOPES } from "./dispatch";
import { RETURN_CODE_PARAM } from "./connect";

// Connecting another app (connect.ts) hands out a credential that reads and
// sends mail, and this code is in scope for the CASA assessment. These tests
// pin every gate: the return URL allowlist, the code exchange (secret, one
// use, expiry, app binding), scope enforcement on the functions the CLI
// calls, revocation, and sealed Gmail credentials.

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./http.ts": () => import("./http"),
  "./auth.ts": () => import("./auth"),
  "./connect.ts": () => import("./connect"),
  "./demo.ts": () => import("./demo"),
  "./devices.ts": () => import("./devices"),
  "./dispatch.ts": () => import("./dispatch"),
  "./sync.ts": () => import("./sync"),
  "./migrations.ts": () => import("./migrations"),
  "./calendar/read.ts": () => import("./calendar/read"),
  "./gmail/oauth.ts": () => import("./gmail/oauth"),
  "./gmail/attachments.ts": () => import("./gmail/attachments"),
  "./search.ts": () => import("./search"),
  "./ai/actions.ts": () => import("./ai/actions"),
  "./ai/draft.ts": () => import("./ai/draft"),
  "./ai/suggest.ts": () => import("./ai/suggest"),
  "./ai/summarize.ts": () => import("./ai/summarize"),
  "./ai/filterSupport.ts": () => import("./ai/filterSupport"),
  "./accounts.ts": () => import("./accounts"),
};

const SECRET = "codecast-test-secret";
const RETURN = "https://codecast.sh/connect/whisk";
const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

const saved: Record<string, string | undefined> = {};
const ENV = ["WHISK_APP_SECRET_CODECAST", "WHISK_APP_RETURN_URLS_CODECAST", "WHISK_CREDENTIALS_KEY"];

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  process.env.WHISK_APP_SECRET_CODECAST = SECRET;
  delete process.env.WHISK_APP_RETURN_URLS_CODECAST;
  process.env.WHISK_CREDENTIALS_KEY = KEY;
});

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  setSystemTime();
});

async function seeded() {
  const t = convexTest(schema, modules);
  const { token } = await t.mutation(api.demo.seed, {});
  return { t, token };
}

type T = ReturnType<typeof convexTest>;

/** Run every scheduled job to the end, including the ones they schedule. */
async function settleScheduled(t: T): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const open = (await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((j) => j.state.kind === "pending" || j.state.kind === "inProgress");
    if (open.length === 0) return;
    await t.finishInProgressScheduledFunctions();
  }
  throw new Error("scheduled jobs never settled");
}

/** The state codecast sends with the connect link and again at the exchange. */
const STATE = "s-1";

async function approve(t: T, token: string, state = STATE): Promise<string> {
  const { redirect } = await t.mutation(api.connect.approve, {
    token,
    app_id: "codecast",
    return_url: RETURN,
    state,
  });
  const url = new URL(redirect);
  expect(url.origin + url.pathname).toBe(RETURN);
  expect(url.searchParams.get("state")).toBe(state);
  // Never `code`: the receiving app's Convex Auth provider would eat it.
  expect(url.searchParams.has("code")).toBe(false);
  return url.searchParams.get(RETURN_CODE_PARAM)!;
}

function exchange(t: T, body: Record<string, unknown>) {
  return t.fetch("/apps/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function connected(t: T, token: string): Promise<string> {
  const code = await approve(t, token);
  const res = await exchange(t, { app_id: "codecast", app_secret: SECRET, code, state: STATE });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

/** A login holding only some scopes, as an older or narrower grant would. */
async function narrowToken(t: T, token: string, scopes: string[]): Promise<string> {
  const { accounts } = await t.query(api.sync.getAccount, { token });
  return await t.run(async (ctx) => {
    const account = await ctx.db.get(accounts[0]._id as Id<"accounts">);
    return await createAuthSession(ctx, account!.user_id!, { app_id: "codecast", scopes });
  });
}

describe("return URLs", () => {
  const app = connectedApp("codecast")!;

  test("only the exact registered address passes", () => {
    expect(isAllowedReturnUrl(app, RETURN)).toBe(true);
    expect(isAllowedReturnUrl(app, `${RETURN}?from=settings`)).toBe(true);
    for (const foreign of [
      "https://evil.example/connect/whisk",
      "https://codecast.sh.evil.example/connect/whisk",
      "https://codecast.sh/connect/whisk/extra",
      "https://codecast.sh/connect",
      "http://codecast.sh/connect/whisk",
      "https://user:pw@codecast.sh/connect/whisk",
      `${RETURN}#frag`,
      "javascript:alert(1)",
      "not a url",
      "http://localhost:3200/connect/whisk",
    ]) {
      expect(isAllowedReturnUrl(app, foreign)).toBe(false);
    }
  });

  test("a deployment can add dev addresses through env", () => {
    process.env.WHISK_APP_RETURN_URLS_CODECAST = "http://localhost:3200/connect/whisk, nonsense";
    expect(isAllowedReturnUrl(app, "http://localhost:3200/connect/whisk")).toBe(true);
    expect(isAllowedReturnUrl(app, "http://localhost:3201/connect/whisk")).toBe(false);
  });

  test("unknown apps and prototype keys resolve to nothing", () => {
    expect(connectedApp("nope")).toBeNull();
    expect(connectedApp("__proto__")).toBeNull();
    expect(connectedApp("toString")).toBeNull();
  });

  test("a result planted on the return URL never survives", async () => {
    const planted = `${RETURN}?from=settings&whisk_code=attacker-code&error=x&state=attacker-state`;
    const { t, token } = await seeded();
    // Decline: Whisk's own error and the request's state, nothing planted.
    const described = await t.query(api.connect.describe, { app_id: "codecast", return_url: planted, state: "s-9" });
    const decline = new URL(described.decline_url);
    expect(decline.searchParams.getAll("whisk_code")).toEqual([]);
    expect(decline.searchParams.getAll("error")).toEqual(["access_denied"]);
    expect(decline.searchParams.getAll("state")).toEqual(["s-9"]);
    expect(decline.searchParams.get("from")).toBe("settings");
    // A request with no state of its own does not inherit the planted one.
    const stateless = await t.query(api.connect.describe, { app_id: "codecast", return_url: planted });
    expect(new URL(stateless.decline_url).searchParams.has("state")).toBe(false);
    // Approve: exactly one code, Whisk's, and no planted error or state.
    const { redirect } = await t.mutation(api.connect.approve, { token, app_id: "codecast", return_url: planted });
    const back = new URL(redirect);
    const codes = back.searchParams.getAll(RETURN_CODE_PARAM);
    expect(codes).toHaveLength(1);
    expect(codes[0]).not.toBe("attacker-code");
    expect(back.searchParams.has("error")).toBe(false);
    expect(back.searchParams.has("state")).toBe(false);
    expect(returnWith(planted, {})).toBe(`${RETURN}?from=settings`);
  });

  test("the connect screen refuses a foreign return before offering anything", async () => {
    const { t, token } = await seeded();
    const described = await t.query(api.connect.describe, {
      app_id: "codecast",
      return_url: RETURN,
      state: "abc",
    });
    expect(described.name).toBe("Codecast");
    expect(described.scopes.map((s) => s.scope)).toContain("mail.send");
    expect(described.decline_url).toBe(`${RETURN}?error=access_denied&state=abc`);
    await expect(
      t.query(api.connect.describe, { app_id: "codecast", return_url: "https://evil.example/x" }),
    ).rejects.toThrow(/does not return to Codecast/);
    await expect(
      t.query(api.connect.describe, { app_id: "nope", return_url: RETURN }),
    ).rejects.toThrow(/does not know this app/);
    await expect(
      t.mutation(api.connect.approve, { token, app_id: "codecast", return_url: "https://evil.example/x" }),
    ).rejects.toThrow(/does not return/);
  });

  test("approving needs the signed-in person, never an app token", async () => {
    const { t, token } = await seeded();
    await expect(
      t.mutation(api.connect.approve, { app_id: "codecast", return_url: RETURN }),
    ).rejects.toThrow(/Unauthorized/);
    const appToken = await connected(t, token);
    await expect(
      t.mutation(api.connect.approve, { token: appToken, app_id: "codecast", return_url: RETURN }),
    ).rejects.toThrow(/Unauthorized/);
  });
});

describe("code exchange", () => {
  test("a good code and secret mint an app token bound to the person", async () => {
    const { t, token } = await seeded();
    const code = await approve(t, token);
    const res = await exchange(t, { app_id: "codecast", app_secret: SECRET, code, state: STATE });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const grant = (await res.json()) as { token: string; email: string; scopes: string[]; connection_id: string };
    expect(grant.email).toContain("@");
    expect(grant.scopes).toContain("mail.read");
    const mine = await t.query(api.sync.getAccount, { token });
    const theirs = await t.query(api.sync.getAccount, { token: grant.token });
    expect(theirs.accounts.map((a) => a._id)).toEqual(mine.accounts.map((a) => a._id));
    // Stored hashed: neither the token nor the code is in the database.
    const stored = await t.run(async (ctx) => ({
      sessions: await ctx.db.query("auth_sessions").collect(),
      codes: await ctx.db.query("app_codes").collect(),
    }));
    expect(JSON.stringify(stored)).not.toContain(grant.token);
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(stored.codes[0].code_hash).toBe(await hashToken(code));
  });

  test("a wrong secret is refused and leaves the code unspent", async () => {
    const { t, token } = await seeded();
    const code = await approve(t, token);
    for (const app_secret of ["wrong", `${SECRET} `, SECRET.slice(0, -1)]) {
      const res = await exchange(t, { app_id: "codecast", app_secret, code, state: STATE });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_client" });
    }
    const good = await exchange(t, { app_id: "codecast", app_secret: SECRET, code, state: STATE });
    expect(good.status).toBe(200);
  });

  test("an app with no secret configured cannot exchange at all", async () => {
    const { t, token } = await seeded();
    const code = await approve(t, token);
    delete process.env.WHISK_APP_SECRET_CODECAST;
    const res = await exchange(t, { app_id: "codecast", app_secret: "", code, state: STATE });
    expect(res.status).toBe(400);
    const res2 = await exchange(t, { app_id: "codecast", app_secret: "anything", code, state: STATE });
    expect(res2.status).toBe(401);
  });

  test("malformed requests and unknown apps", async () => {
    const { t } = await seeded();
    const bad = await t.fetch("/apps/token", { method: "POST", body: "not json" });
    expect(bad.status).toBe(400);
    expect((await exchange(t, { app_id: "codecast", app_secret: SECRET })).status).toBe(400);
    const unknown = await exchange(t, { app_id: "other", app_secret: SECRET, code: "x" });
    expect(unknown.status).toBe(401);
    const forged = await exchange(t, { app_id: "codecast", app_secret: SECRET, code: "made-up" });
    expect(forged.status).toBe(400);
    expect(await forged.json()).toEqual({ error: "invalid_grant" });
  });

  test("a reused code is refused and revokes the token it first minted", async () => {
    const { t, token } = await seeded();
    const code = await approve(t, token);
    const first = await exchange(t, { app_id: "codecast", app_secret: SECRET, code, state: STATE });
    const { token: appToken } = (await first.json()) as { token: string };
    await t.query(api.sync.getAccount, { token: appToken });
    const again = await exchange(t, { app_id: "codecast", app_secret: SECRET, code, state: STATE });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_grant" });
    await expect(t.query(api.sync.getAccount, { token: appToken })).rejects.toThrow(/Unauthorized/);
  });

  test("an expired code is refused", async () => {
    const { t, token } = await seeded();
    const start = Date.now();
    setSystemTime(new Date(start));
    const code = await approve(t, token);
    setSystemTime(new Date(start + 5 * 60 * 1000 + 1));
    const res = await exchange(t, { app_id: "codecast", app_secret: SECRET, code, state: STATE });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
  });

  test("a code redeems only with the state it was issued with", async () => {
    const { t, token } = await seeded();
    const code = await approve(t, token);
    // Another person's state at the app, or none, spends nothing.
    for (const body of [{ state: "someone-else" }, {}, { state: "" }]) {
      const res = await exchange(t, { app_id: "codecast", app_secret: SECRET, code, ...body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_grant" });
    }
    const good = await exchange(t, { app_id: "codecast", app_secret: SECRET, code, state: STATE });
    expect(good.status).toBe(200);
    // Only the state's hash is stored.
    const codes = await t.run((ctx) => ctx.db.query("app_codes").collect());
    expect(codes[0].state_hash).toBe(await hashToken(STATE));
    expect(JSON.stringify(codes)).not.toContain(`"${STATE}"`);
  });

  test("a code issued without a state needs none", async () => {
    const { t, token } = await seeded();
    const { redirect } = await t.mutation(api.connect.approve, { token, app_id: "codecast", return_url: RETURN });
    const code = new URL(redirect).searchParams.get(RETURN_CODE_PARAM)!;
    const res = await exchange(t, { app_id: "codecast", app_secret: SECRET, code });
    expect(res.status).toBe(200);
  });

  test("a code only redeems for the app it was issued to", async () => {
    const { t, token } = await seeded();
    const code = await approve(t, token);
    const other = await t.mutation(internal.connect.redeem, { app_id: "other", code });
    expect(other).toEqual({ ok: false, error: "invalid_grant", reason: "unknown" });
  });

  test("expired and spent codes are pruned", async () => {
    const { t, token } = await seeded();
    const start = Date.now();
    setSystemTime(new Date(start));
    await approve(t, token);
    await connected(t, token);
    setSystemTime(new Date(start + 6 * 60 * 1000));
    expect(await t.mutation(internal.connect.pruneCodes, {})).toEqual({ pruned: 2 });
  });
});

describe("scopes", () => {
  test("an app token reads mail and calendar the way the CLI does", async () => {
    const { t, token } = await seeded();
    const appToken = await connected(t, token);
    const threads = await t.query(api.sync.listThreads, { token: appToken });
    expect(threads.rows.length).toBeGreaterThan(0);
    await t.query(api.calendar.read.listCalendars, { token: appToken });
    const done = await t.mutation(api.dispatch.dispatch, {
      token: appToken,
      action: "applyThreadOps",
      args: { ops: [] },
    });
    expect(done).toEqual({ applied: [] });
  });

  test("an app token never reaches functions outside every scope", async () => {
    const { t, token } = await seeded();
    const appToken = await connected(t, token);
    await expect(t.query(api.devices.list, { token: appToken })).rejects.toThrow(/Unauthorized/);
    await expect(
      t.mutation(api.devices.mint, { token: appToken, device_name: "x" }),
    ).rejects.toThrow(/Unauthorized/);
    await expect(t.query(api.connect.list, { token: appToken })).rejects.toThrow(/Unauthorized/);
    for (const action of ["deleteForever", "disconnectAccount", "signOut", "addMemory", "deleteEvent", "rsvpEvent"]) {
      await expect(
        t.mutation(api.dispatch.dispatch, { token: appToken, action, args: {} }),
      ).rejects.toThrow(/Unauthorized/);
    }
    // Prefs are the person's own: a patch from an app is refused even riding
    // an action the app may run.
    await expect(
      t.mutation(api.dispatch.dispatch, {
        token: appToken,
        action: "applyThreadOps",
        args: { ops: [] },
        patches: { client_state: { theme: "dark" } },
      }),
    ).rejects.toThrow(/Unauthorized/);
    // An unknown action is no way around it.
    await expect(
      t.mutation(api.dispatch.dispatch, { token: appToken, action: "constructor", args: {} }),
    ).rejects.toThrow(/Unauthorized/);
  });

  test("a narrower grant reaches only its own scopes", async () => {
    const { t, token } = await seeded();
    const readOnly = await narrowToken(t, token, ["mail.read"]);
    await t.query(api.sync.listThreads, { token: readOnly });
    await expect(t.query(api.calendar.read.listEvents, { token: readOnly })).rejects.toThrow(/Unauthorized/);
    for (const action of ["sendMessage", "saveDraft", "applyThreadOps", "createEvent"]) {
      await expect(
        t.mutation(api.dispatch.dispatch, { token: readOnly, action, args: {} }),
      ).rejects.toThrow(/Unauthorized/);
    }
    const calendarOnly = await narrowToken(t, token, ["calendar.read"]);
    await t.query(api.calendar.read.listEvents, { token: calendarOnly });
    await expect(t.query(api.sync.listThreads, { token: calendarOnly })).rejects.toThrow(/Unauthorized/);
  });

  test("changing an event needs calendar.write", async () => {
    const { t, token } = await seeded();
    const appToken = await connected(t, token);
    const update = (as: string) =>
      t.mutation(api.dispatch.dispatch, {
        token: as,
        action: "updateEvent",
        args: { calendar_google_id: "primary", google_id: "no-such-event", patch: { summary: "Moved" } },
      });
    // Past the scope check: the calendar lookup is what refuses.
    await expect(update(appToken)).rejects.toThrow(/No such calendar/);
    await expect(update(await narrowToken(t, token, ["calendar.read"]))).rejects.toThrow(/Unauthorized/);
    expect(DISPATCH_SCOPES.updateEvent).toBe("calendar.write");
  });

  test("a filter dry run reads mail, so it needs mail.read as well as mail.organize", async () => {
    const { t, token } = await seeded();
    const preview = (as: string) =>
      t.action(api.ai.actions.previewFilter, { token: as, condition: "mentions a bank transfer" });
    await expect(preview(await narrowToken(t, token, ["mail.organize"]))).rejects.toThrow(/Unauthorized/);
    await expect(preview(await narrowToken(t, token, ["mail.read"]))).rejects.toThrow(/Unauthorized/);
    // Both held: past the scope check (what stops it here is the test
    // deployment having no model configured, or the model call itself).
    const both = await preview(await narrowToken(t, token, ["mail.read", "mail.organize"])).catch((e: Error) => e);
    expect(both instanceof Error ? both.message : "").not.toMatch(/Unauthorized/);
  });

  test("drafts and suggestions are written from the thread, so they need mail.read as well as mail.draft", async () => {
    const { t, token } = await seeded();
    const [thread] = (await t.query(api.sync.listThreads, { token })).rows;
    const contexts = [internal.ai.draft.contextForThread, internal.ai.suggest.contextForSuggest] as const;
    const draftOnly = await narrowToken(t, token, ["mail.draft"]);
    const readOnly = await narrowToken(t, token, ["mail.read"]);
    const both = await narrowToken(t, token, ["mail.read", "mail.draft"]);
    for (const context of contexts) {
      await expect(t.query(context, { token: draftOnly, threadGmailId: thread.gmail_id })).rejects.toThrow(/Unauthorized/);
      await expect(t.query(context, { token: readOnly, threadGmailId: thread.gmail_id })).rejects.toThrow(/Unauthorized/);
      await t.query(context, { token: both, threadGmailId: thread.gmail_id });
    }
    // The public actions resolve through those contexts.
    await expect(
      t.action(api.ai.actions.draftReply, { token: draftOnly, threadGmailId: thread.gmail_id }),
    ).rejects.toThrow(/Unauthorized/);
  });

  test("an app's model calls draw on the mailbox's hourly budget; the person's own do not", async () => {
    const { t, token } = await seeded();
    const appToken = await connected(t, token);
    const { accounts } = await t.query(api.sync.getAccount, { token });
    const accountId = accounts[0]._id as Id<"accounts">;
    const spent = async () => (await t.run(async (ctx) => (await ctx.db.get(accountId))?.ai_window_spent)) ?? 0;
    await t.mutation(internal.ai.filterSupport.takeModelBudget, { accountId, cost: 1, appToken: token });
    expect(await spent()).toBe(0);
    await t.mutation(internal.ai.filterSupport.takeModelBudget, { accountId, cost: 1, appToken });
    expect(await spent()).toBe(1);
    // A rewrite is bounded, and every caller pays for it, app or person.
    await expect(
      t.action(api.ai.actions.rewrite, { token: appToken, text: "x".repeat(20_001), instruction: "shorter" }),
    ).rejects.toThrow(/at most/);
    await expect(
      t.action(api.ai.actions.rewrite, { token: appToken, text: "Hi", instruction: "x".repeat(2_001) }),
    ).rejects.toThrow(/at most/);
    expect(await spent()).toBe(1);
    await t.action(api.ai.actions.rewrite, { token, text: "Hi there", instruction: "shorter" }).catch(() => null);
    expect(await spent()).toBe(2);
    await t.run(async (ctx) => ctx.db.patch(accountId, { ai_window_spent: 120 }));
    await expect(
      t.action(api.ai.actions.rewrite, { token: appToken, text: "Hi there", instruction: "shorter" }),
    ).rejects.toThrow(/hour of on-demand AI/);
  });

  test("an app token fetches attachments only from the Authorization header", async () => {
    const { t, token } = await seeded();
    const appToken = await connected(t, token);
    const path = "/gmail/attachment?message=no-such-message&id=a1";
    expect((await t.fetch(`${path}&token=${appToken}`)).status).toBe(401);
    // From the header it passes the check; the message is what is missing.
    const viaHeader = await t.fetch(path, { headers: { Authorization: `Bearer ${appToken}` } });
    expect(viaHeader.status).toBe(404);
    // The person's own token still works in the URL, as Whisk's <img> tags need.
    expect((await t.fetch(`${path}&token=${token}`)).status).toBe(404);
  });

  test("a scope the registry no longer grants is dead, as is an unknown app", async () => {
    const { t, token } = await seeded();
    const madeUp = await narrowToken(t, token, ["mail.everything"]);
    await expect(t.query(api.sync.listThreads, { token: madeUp })).rejects.toThrow(/Unauthorized/);
    const { accounts } = await t.query(api.sync.getAccount, { token });
    const stranger = await t.run(async (ctx) => {
      const account = await ctx.db.get(accounts[0]._id as Id<"accounts">);
      return await createAuthSession(ctx, account!.user_id!, { app_id: "gone", scopes: ["mail.read"] });
    });
    await expect(t.query(api.sync.listThreads, { token: stranger })).rejects.toThrow(/Unauthorized/);
  });

  test("every side effect has a decision, and the destructive ones are closed", () => {
    expect(DISPATCH_SCOPES.deleteForever).toBeNull();
    expect(DISPATCH_SCOPES.disconnectAccount).toBeNull();
    expect(DISPATCH_SCOPES.signOut).toBeNull();
    expect(DISPATCH_SCOPES.sendMessage).toBe("mail.send");
    expect(DISPATCH_SCOPES.createEvent).toBe("calendar.write");
  });

  test("an app token cannot attach a mailbox to the person", async () => {
    const { t, token } = await seeded();
    const appToken = await connected(t, token);
    const attached = await t.run(async (ctx) => {
      const { attachAccountToSession } = await import("./lib/auth");
      const account = (await ctx.db.query("accounts").collect())[0];
      return await attachAccountToSession(ctx, await hashToken(appToken), account._id);
    });
    expect(attached).toBe(false);
  });
});

describe("revocation and Settings", () => {
  test("Settings lists the app with its last use, and revoke ends it at once", async () => {
    const { t, token } = await seeded();
    const appToken = await connected(t, token);
    const devices = await t.query(api.devices.list, { token });
    expect(devices.every((d) => d.device_name !== "Codecast")).toBe(true);
    const [row] = await t.query(api.connect.list, { token });
    expect(row.name).toBe("Codecast");
    expect(row.scopes.map((s) => s.scope)).toEqual([
      "mail.read",
      "mail.draft",
      "mail.send",
      "mail.organize",
      "calendar.read",
      "calendar.write",
    ]);
    const before = row.last_used_at;
    setSystemTime(new Date(before + 60_000));
    await t.mutation(api.dispatch.dispatch, { token: appToken, action: "applyThreadOps", args: { ops: [] } });
    const [after] = await t.query(api.connect.list, { token });
    expect(after.last_used_at).toBe(before + 60_000);
    // Uses within the minute do not write again.
    setSystemTime(new Date(before + 90_000));
    await t.mutation(api.dispatch.dispatch, { token: appToken, action: "applyThreadOps", args: { ops: [] } });
    expect((await t.query(api.connect.list, { token }))[0].last_used_at).toBe(before + 60_000);
    // A read through an action records the use too.
    setSystemTime(new Date(before + 200_000));
    await t.action(api.search.runFullSearch, { token: appToken, q: "hello" });
    expect((await t.query(api.connect.list, { token }))[0].last_used_at).toBe(before + 200_000);
    // A device revoke cannot be pointed at an app row; the app revoke can.
    await expect(
      t.mutation(api.devices.revoke, { token, session_id: row._id }),
    ).rejects.toThrow(/not found/);
    await t.mutation(api.connect.revoke, { token, connection_id: row._id });
    await expect(t.query(api.sync.listThreads, { token: appToken })).rejects.toThrow(/Unauthorized/);
    expect(await t.query(api.connect.list, { token })).toEqual([]);
  });

  test("another person cannot revoke the connection", async () => {
    const a = await seeded();
    await connected(a.t, a.token);
    const b = await a.t.mutation(api.demo.seed, {});
    const [row] = await a.t.query(api.connect.list, { token: a.token });
    await expect(
      a.t.mutation(api.connect.revoke, { token: b.token, connection_id: row._id }),
    ).rejects.toThrow(/not found/);
  });

  test("the app can end its own connection, and reconnecting replaces it", async () => {
    const { t, token } = await seeded();
    const first = await connected(t, token);
    const second = await connected(t, token);
    await expect(t.query(api.sync.getAccount, { token: first })).rejects.toThrow(/Unauthorized/);
    expect(await t.query(api.connect.list, { token })).toHaveLength(1);
    expect(await t.mutation(api.connect.disconnect, { token: second })).toEqual({ disconnected: true });
    await expect(t.query(api.sync.getAccount, { token: second })).rejects.toThrow(/Unauthorized/);
    // A person's own login is never ended through the app path.
    expect(await t.mutation(api.connect.disconnect, { token })).toEqual({ disconnected: false });
    await t.query(api.sync.getAccount, { token });
  });
});

describe("sealed Gmail credentials", () => {
  const A = "accounts:a" as Id<"accounts">;
  const B = "accounts:b" as Id<"accounts">;

  test("seal and open round trip; tampering and a clear legacy value fail", async () => {
    const sealed = await sealCredential("ya29.secret", A, "access_token");
    expect(sealed.startsWith("enc2:")).toBe(true);
    expect(sealed).not.toContain("ya29");
    expect(await sealCredential(sealed, A, "access_token")).toBe(sealed);
    expect(await openCredential(sealed, A, "access_token")).toBe("ya29.secret");
    const flipped = sealed.slice(0, -2) + (sealed.at(-2) === "A" ? "B" : "A") + sealed.at(-1);
    await expect(openCredential(flipped, A, "access_token")).rejects.toThrow(/would not open/);
    await expect(openCredential("legacy-clear", A, "access_token")).rejects.toThrow(/would not open/);
    process.env.WHISK_CREDENTIALS_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    await expect(openCredential(sealed, A, "access_token")).rejects.toThrow(/would not open/);
    delete process.env.WHISK_CREDENTIALS_KEY;
    await expect(sealCredential("x", A, "access_token")).rejects.toThrow(/not configured/);
  });

  test("a sealed token is bound to its account and field", async () => {
    const sealed = await sealCredential("1//refresh", A, "refresh_token");
    // The binding is inside the ciphertext, not readable beside it.
    expect(sealed).not.toContain("accounts:a");
    // Copied into another account's row, or into the other field: refused.
    await expect(openCredential(sealed, B, "refresh_token")).rejects.toThrow(/would not open/);
    await expect(openCredential(sealed, A, "access_token")).rejects.toThrow(/would not open/);
    expect(await openCredential(sealed, A, "refresh_token")).toBe("1//refresh");
  });

  test("an unbound enc1 value opens only on the migration path, which reseals it bound", async () => {
    const enc1 = "enc1:" + (await encryptAESGCMString("old-refresh", KEY));
    expect(isSealed(enc1)).toBe(false);
    // From an old backup, pasted into a row: the read path refuses it, and it
    // is never sealed as if it were a token.
    await expect(openCredential(enc1, A, "refresh_token")).rejects.toThrow(/would not open/);
    await expect(sealCredential(enc1, A, "refresh_token")).rejects.toThrow(/would not open/);
    const bound = await resealLegacyCredential(enc1, A, "refresh_token");
    expect(bound.startsWith("enc2:")).toBe(true);
    expect(await openCredential(bound, A, "refresh_token")).toBe("old-refresh");
    expect(await resealLegacyCredential(bound, A, "refresh_token")).toBe(bound);
  });

  test("the migration seals clear and unbound rows and the token getter still reads them", async () => {
    const { t } = await seeded();
    const enc1 = "enc1:" + (await encryptAESGCMString("unbound-refresh", KEY));
    const accountId = await t.run(async (ctx) => {
      const account = (await ctx.db.query("accounts").collect())[0];
      await ctx.db.insert("credentials", {
        account_id: account._id,
        access_token: "clear-access",
        refresh_token: enc1,
        expiry: Date.now() + 3_600_000,
      });
      return account._id;
    });
    expect(await t.query(internal.migrations.unsealedCredentials, {})).toEqual({ total: 1, unsealed: 1 });
    await expect(t.query(internal.gmail.oauth.credentialsFor, { accountId })).rejects.toThrow(/would not open/);
    expect(await t.mutation(internal.migrations.sealCredentials, {})).toEqual({ sealed: 1, done: true });
    expect(await t.mutation(internal.migrations.sealCredentials, {})).toEqual({ sealed: 0, done: true });
    expect(await t.query(internal.migrations.unsealedCredentials, {})).toEqual({ total: 1, unsealed: 0 });
    const raw = await t.run(async (ctx) => (await ctx.db.query("credentials").collect())[0]);
    expect(raw.access_token.startsWith("enc2:")).toBe(true);
    expect(raw.refresh_token.startsWith("enc2:")).toBe(true);
    expect(raw.access_token).not.toContain("clear");
    const opened = await t.query(internal.gmail.oauth.credentialsFor, { accountId });
    expect(opened?.access_token).toBe("clear-access");
    expect(opened?.refresh_token).toBe("unbound-refresh");
    // A refresh writes the new access token sealed and keeps the refresh token.
    await t.mutation(internal.gmail.oauth.storeCredentials, {
      accountId,
      access_token: "fresh-access",
      expiry: Date.now() + 3_600_000,
    });
    const refreshed = await t.query(internal.gmail.oauth.credentialsFor, { accountId });
    expect(refreshed?.access_token).toBe("fresh-access");
    expect(refreshed?.refresh_token).toBe("unbound-refresh");
    const raw2 = await t.run(async (ctx) => (await ctx.db.query("credentials").collect())[0]);
    expect(raw2.access_token.startsWith("enc2:")).toBe(true);

    // Another account's sealed refresh token pasted into this row does not open here.
    const otherAccount = await t.run(async (ctx) =>
      ctx.db.insert("accounts", {
        email: "other@example.com",
        provider: "gmail",
        sync_status: "idle",
        scopes: [],
        updated_at: Date.now(),
      }),
    );
    const foreign = await sealCredential("victim-refresh", otherAccount, "refresh_token");
    await t.run(async (ctx) => ctx.db.patch(raw2._id, { refresh_token: foreign }));
    await expect(t.query(internal.gmail.oauth.credentialsFor, { accountId })).rejects.toThrow(/would not open/);
  });

  test("a disconnect schedules the Google revoke with the token still sealed", async () => {
    const { t, token } = await seeded();
    const { accounts } = await t.query(api.sync.getAccount, { token });
    const accountId = accounts[0]._id as Id<"accounts">;
    const sealed = await sealCredential("1//plain-refresh", accountId, "refresh_token");
    await t.run(async (ctx) => {
      await ctx.db.patch(accountId, { provider: "gmail" });
      await ctx.db.insert("credentials", {
        account_id: accountId,
        access_token: await sealCredential("ya29.plain", accountId, "access_token"),
        refresh_token: sealed,
        expiry: Date.now() + 3_600_000,
      });
    });
    // The revoke calls Google; answer it here, and let the disconnect's jobs
    // finish before the test ends, or they land in the next file's harness.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    try {
      await t.mutation(api.dispatch.dispatch, { token, action: "disconnectAccount", args: {} });
      const jobs = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
      const revoke = jobs.find((j) => j.name.includes("revokeToken"));
      expect(revoke?.args[0]).toEqual({ accountId, sealed });
      expect(JSON.stringify(jobs)).not.toContain("plain-refresh");
      expect(JSON.stringify(jobs)).not.toContain("ya29.plain");
      await settleScheduled(t);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
