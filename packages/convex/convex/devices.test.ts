import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./auth.ts": () => import("./auth"),
  "./demo.ts": () => import("./demo"),
  "./devices.ts": () => import("./devices"),
  "./dispatch.ts": () => import("./dispatch"),
  "./sync.ts": () => import("./sync"),
};

async function seeded() {
  const t = convexTest(schema, modules);
  const { token, accountId } = await t.mutation(api.demo.seed, {});
  return { t, token, accountId };
}

describe("device logins", () => {
  test("a minted token reads the same roster and can be revoked", async () => {
    const { t, token } = await seeded();
    const minted = await t.mutation(api.devices.mint, {
      token,
      device_name: "laptop",
    });
    expect(minted.token).not.toBe(token);
    expect(minted.email).toContain("@");

    const viaWeb = await t.query(api.sync.getAccount, { token });
    const viaCli = await t.query(api.sync.getAccount, { token: minted.token });
    expect(viaCli.accounts.map((a) => a._id)).toEqual(
      viaWeb.accounts.map((a) => a._id),
    );

    const devices = await t.query(api.devices.list, { token: minted.token });
    expect(devices).toHaveLength(2);
    const me = devices.find((d) => d.current)!;
    expect(me.device_name).toBe("laptop");

    await t.mutation(api.devices.revoke, { token, session_id: me._id });
    await expect(
      t.query(api.sync.getAccount, { token: minted.token }),
    ).rejects.toThrow(/Unauthorized/);
    expect(await t.query(api.devices.list, { token })).toHaveLength(1);
  });

  test("minting needs a signed-in caller", async () => {
    const { t } = await seeded();
    await expect(
      t.mutation(api.devices.mint, { device_name: "x" }),
    ).rejects.toThrow(/Unauthorized/);
    await expect(
      t.mutation(api.devices.mint, { token: "nope", device_name: "x" }),
    ).rejects.toThrow(/Unauthorized/);
  });

  test("a device cannot revoke another user's login", async () => {
    const a = await seeded();
    const b = await a.t.mutation(api.demo.seed, {});
    const mine = await a.t.query(api.devices.list, { token: a.token });
    await expect(
      a.t.mutation(api.devices.revoke, {
        token: b.token,
        session_id: mine[0]._id,
      }),
    ).rejects.toThrow(/not found/);
  });

  test("mintForEmail bootstraps a token for a connected address", async () => {
    const { t, token } = await seeded();
    const { accounts } = await t.query(api.sync.getAccount, { token });
    const minted = await t.mutation(internal.devices.mintForEmail, {
      email: accounts[0].email,
      device_name: "admin",
    });
    const roster = await t.query(api.sync.getAccount, { token: minted.token });
    expect(roster.accounts[0].email).toBe(accounts[0].email);
    await expect(
      t.mutation(internal.devices.mintForEmail, {
        email: "nobody@example.com",
        device_name: "admin",
      }),
    ).rejects.toThrow(/No connected account/);
  });
});

describe("push devices", () => {
  test("registerPush stores a token the user can read back", async () => {
    const { t, token } = await seeded();
    await t.mutation(api.devices.registerPush, {
      token,
      push_token: "ExponentPushToken[abc]",
      platform: "ios",
      time_zone: "America/Los_Angeles",
    });
    const phones = await t.query(api.devices.myPush, { token });
    expect(phones).toHaveLength(1);
    expect(phones[0].platform).toBe("ios");
    await t.mutation(api.devices.registerPush, {
      token,
      push_token: "ExponentPushToken[abc]",
      platform: "ios",
    });
    expect(await t.query(api.devices.myPush, { token })).toHaveLength(1);
    await t.mutation(api.devices.unregisterPush, {
      token,
      push_token: "ExponentPushToken[abc]",
    });
    expect(await t.query(api.devices.myPush, { token })).toHaveLength(0);
  });
});

describe("threadsByIds", () => {
  test("resolves thread ids and message ids to thread rows", async () => {
    const { t, token } = await seeded();
    const messages = await t.query(api.sync.threadMessages, {
      token,
      threadGmailId: "demo-thread-02",
    });
    const rows = await t.query(api.sync.threadsByIds, {
      token,
      gmailIds: ["demo-thread-01", messages[0].gmail_id, "missing"],
    });
    expect(rows.map((r) => r.gmail_id)).toEqual([
      "demo-thread-01",
      "demo-thread-02",
    ]);
  });
});
