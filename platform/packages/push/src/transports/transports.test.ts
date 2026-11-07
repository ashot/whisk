// No network: every transport takes an injected fetch, and the APNs signer is
// exercised against a P-256 key generated in the test.

import { describe, expect, test } from "bun:test";
import { createExpoTransport, EXPO_PUSH_ENDPOINT, expoMessageFor } from "./expo";
import {
  apnsAlertPayload,
  apnsConfigFromEnv,
  apnsConfigured,
  createApnsTransport,
  createApnsVoipSender,
  sendApns,
  voipPayload,
  webCryptoSigner,
  type ApnsConfig,
} from "./apns";
import { createPushRouter } from "./router";
import {
  dedupeTargets,
  type FetchLike,
  type Logger,
  type PushMessage,
  type PushTarget,
} from "./types";

const MESSAGE: PushMessage = {
  title: "3 notifications",
  body: "2 sessions waiting for input · 1 permission request",
  data: { type: "aggregate", count: 3 },
  badge: 3,
};

function recorder(): { logger: Logger; warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    warns,
    errors,
    logger: {
      warn: (...args) => warns.push(args.join(" ")),
      error: (...args) => errors.push(args.join(" ")),
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function capturingFetch(response: () => Response): {
  fetch: FetchLike;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response();
    },
  };
}

describe("token dedup", () => {
  test("one entry per token, first occurrence wins", () => {
    const targets: PushTarget[] = [
      { token: "a", platform: "ios" },
      { token: "b" },
      { token: "a", platform: "android" },
      { token: "" },
    ];
    const { unique, deduped } = dedupeTargets(targets);
    expect(unique.map((t) => t.token)).toEqual(["a", "b"]);
    expect(unique[0].platform).toBe("ios");
    expect(deduped).toBe(2);
  });

  test("expo sends one message per device, never two for one token", async () => {
    const { fetch, calls } = capturingFetch(() =>
      jsonResponse({ data: [{ status: "ok" }, { status: "ok" }] }),
    );
    const transport = createExpoTransport({ fetch });
    const result = await transport.send(
      [{ token: "a" }, { token: "a" }, { token: "b" }],
      MESSAGE,
    );
    expect(result.sent).toBe(2);
    expect(result.deduped).toBe(1);
    const body = JSON.parse(String(calls[0].init?.body)) as Array<{ to: string }>;
    expect(body.map((m) => m.to)).toEqual(["a", "b"]);
  });

  test("the router dedupes across transports before grouping", async () => {
    const seen: Record<string, string[][]> = { expo: [], apns: [] };
    const stub = (name: string) => ({
      name,
      async send(targets: PushTarget[]) {
        seen[name].push(targets.map((t) => t.token));
        return { sent: targets.length, deduped: 0, deadTokens: [], errors: [] };
      },
    });
    const router = createPushRouter({
      transports: { expo: stub("expo"), apns: stub("apns") },
    });
    const result = await router.send(
      [
        { token: "a", transport: "expo" },
        { token: "a", transport: "apns" },
        { token: "b", transport: "apns" },
      ],
      MESSAGE,
    );
    expect(seen.expo).toEqual([["a"]]);
    expect(seen.apns).toEqual([["b"]]);
    expect(result).toMatchObject({ sent: 2, deduped: 1 });
  });

  test("a token no transport claims is logged, not thrown", async () => {
    const rec = recorder();
    const router = createPushRouter({
      transports: {
        expo: {
          name: "expo",
          async send() {
            return { sent: 1, deduped: 0, deadTokens: [], errors: [] };
          },
        },
        apns: {
          name: "apns",
          async send() {
            return { sent: 1, deduped: 0, deadTokens: [], errors: [] };
          },
        },
      },
      logger: rec.logger,
    });
    const result = await router.send([{ token: "a" }], MESSAGE);
    expect(result.sent).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(rec.warns[0]).toContain("no transport");
  });
});

describe("expo transport", () => {
  test("the message carries every optional field the app set", () => {
    const built = expoMessageFor({ token: "t" }, {
      ...MESSAGE,
      subtitle: "#releases",
      channelId: "chat",
      interruptionLevel: "time-sensitive",
      categoryId: "huddle_ring",
      sound: "ring.caf",
      ttlSeconds: 45,
      contentAvailable: true,
    });
    expect(built).toMatchObject({
      to: "t",
      subtitle: "#releases",
      channelId: "chat",
      interruptionLevel: "time-sensitive",
      categoryId: "huddle_ring",
      sound: "ring.caf",
      ttl: 45,
      badge: 3,
      priority: "high",
      _contentAvailable: true,
    });
    expect("_contentAvailable" in expoMessageFor({ token: "t" }, MESSAGE)).toBe(false);
  });

  test("a hundred devices per request", async () => {
    const { fetch, calls } = capturingFetch(() => jsonResponse({ data: [] }));
    const transport = createExpoTransport({ fetch });
    const targets = Array.from({ length: 250 }, (_, i) => ({ token: `t${i}` }));
    await transport.send(targets, MESSAGE);
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe(EXPO_PUSH_ENDPOINT);
  });

  test("a network failure is logged and dropped, never retried", async () => {
    const rec = recorder();
    let attempts = 0;
    const transport = createExpoTransport({
      logger: rec.logger,
      fetch: async () => {
        attempts++;
        throw new Error("connection reset");
      },
    });
    const result = await transport.send([{ token: "t" }], MESSAGE);
    expect(attempts).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.errors[0]).toContain("connection reset");
    expect(rec.warns).toHaveLength(1);
  });

  test("a rejected request is logged and dropped, never retried", async () => {
    const rec = recorder();
    let attempts = 0;
    const transport = createExpoTransport({
      logger: rec.logger,
      fetch: async () => {
        attempts++;
        return new Response("too many requests", { status: 429 });
      },
    });
    const result = await transport.send([{ token: "t" }], MESSAGE);
    expect(attempts).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.errors[0]).toContain("429");
  });

  test("a dead token comes back to be cleared", async () => {
    const rec = recorder();
    const transport = createExpoTransport({
      logger: rec.logger,
      fetch: async () =>
        jsonResponse({
          data: [
            { status: "ok" },
            { status: "error", details: { error: "DeviceNotRegistered" } },
          ],
        }),
    });
    const result = await transport.send([{ token: "live" }, { token: "dead" }], MESSAGE);
    expect(result.sent).toBe(1);
    expect(result.deadTokens).toEqual(["dead"]);
    expect(rec.warns).toHaveLength(1);
  });
});

// A throwaway P-256 key, generated here. Nothing in this repo carries a real
// APNs key, team id, or bundle id.
async function testKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const bytes = new Uint8Array(pkcs8);
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  const b64 = btoa(raw).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

const PLACEHOLDER: Omit<ApnsConfig, "authKey"> = {
  keyId: "KEYID00000",
  teamId: "TEAMID0000",
  bundleId: "com.example.app",
};

describe("apns transport", () => {
  test("configuration is checked before anything is signed", async () => {
    const rec = recorder();
    let called = false;
    const res = await sendApns(
      {
        ...PLACEHOLDER,
        authKey: undefined,
        logger: rec.logger,
        fetch: async () => {
          called = true;
          return new Response("", { status: 200 });
        },
      },
      { token: "t", payload: {}, topic: "com.example.app", pushType: "alert" },
    );
    expect(called).toBe(false);
    expect(res).toMatchObject({ ok: false, reason: "not configured" });
    expect(apnsConfigured({ ...PLACEHOLDER, authKey: undefined })).toBe(false);
  });

  test("environment variables become configuration, with no baked in ids", () => {
    expect(apnsConfigFromEnv({})).toBe(null);
    const config = apnsConfigFromEnv({
      APNS_KEY_ID: "KEYID00000",
      APNS_TEAM_ID: "TEAMID0000",
      APNS_AUTH_KEY: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
      APNS_BUNDLE_ID: "com.example.app",
      APNS_ENV: "sandbox",
    });
    expect(config).toMatchObject({
      keyId: "KEYID00000",
      bundleId: "com.example.app",
      environment: "sandbox",
    });
  });

  test("a real ES256 provider token is minted and sent as a bearer", async () => {
    const pem = await testKeyPem();
    const { fetch, calls } = capturingFetch(() => new Response("", { status: 200 }));
    const transport = createApnsTransport({ ...PLACEHOLDER, authKey: pem, fetch });
    const result = await transport.send([{ token: "abc" }], MESSAGE);
    expect(result.sent).toBe(1);

    const headers = calls[0].init?.headers as Record<string, string>;
    const jwt = headers.authorization.replace("bearer ", "");
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(atob(header))).toEqual({ alg: "ES256", kid: "KEYID00000" });
    expect(JSON.parse(atob(claims)).iss).toBe("TEAMID0000");
    // Raw r||s, 64 bytes, base64url encoded.
    expect(signature.length).toBeGreaterThan(80);
    expect(headers["apns-topic"]).toBe("com.example.app");
    expect(headers["apns-push-type"]).toBe("alert");
    expect(calls[0].url).toBe("https://api.push.apple.com/3/device/abc");
  });

  test("the sandbox environment picks the sandbox host", async () => {
    const { fetch, calls } = capturingFetch(() => new Response("", { status: 200 }));
    await sendApns(
      {
        ...PLACEHOLDER,
        authKey: "x",
        environment: "sandbox",
        fetch,
        signer: async () => "stub.jwt.sig",
      },
      { token: "abc", payload: {}, topic: "com.example.app", pushType: "alert" },
    );
    expect(calls[0].url).toBe("https://api.sandbox.push.apple.com/3/device/abc");
  });

  test("the alert payload keeps the app's own data alongside aps", () => {
    const payload = apnsAlertPayload({
      ...MESSAGE,
      subtitle: "#releases",
      interruptionLevel: "time-sensitive",
    }) as { aps: Record<string, unknown>; type?: string };
    expect(payload.aps).toMatchObject({
      alert: { title: MESSAGE.title, subtitle: "#releases", body: MESSAGE.body },
      badge: 3,
      "interruption-level": "time-sensitive",
    });
    expect(payload.type).toBe("aggregate");
  });

  test("a rejected push is logged and dropped, never retried", async () => {
    const rec = recorder();
    let attempts = 0;
    const transport = createApnsTransport({
      ...PLACEHOLDER,
      authKey: "x",
      logger: rec.logger,
      signer: async () => "stub.jwt.sig",
      fetch: async () => {
        attempts++;
        return jsonResponse({ reason: "TooManyRequests" }, 429);
      },
    });
    const result = await transport.send([{ token: "t" }], MESSAGE);
    expect(attempts).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.deadTokens).toEqual([]);
    expect(rec.errors[0]).toContain("TooManyRequests");
  });

  test("a dead token comes back to be cleared", async () => {
    const transport = createApnsTransport({
      ...PLACEHOLDER,
      authKey: "x",
      logger: recorder().logger,
      signer: async () => "stub.jwt.sig",
      fetch: async () => jsonResponse({ reason: "BadDeviceToken" }, 400),
    });
    const result = await transport.send([{ token: "gone" }], MESSAGE);
    expect(result.deadTokens).toEqual(["gone"]);
  });
});

describe("voip", () => {
  test("the ring payload matches the native contract", () => {
    const payload = voipPayload(
      {
        callId: "invite-1",
        callerId: "u2",
        callerName: "Sam",
        callerImage: "https://example.com/a.png",
        metadata: { room_key: "room-1" },
      },
      1_700_000_000_000,
    ) as { incomingCall: Record<string, unknown> };
    expect(payload.incomingCall).toMatchObject({
      eventId: "invite-1:1700000000000",
      serverCallId: "invite-1",
      hasVideo: false,
      caller: { id: "u2", displayName: "Sam", avatarUrl: "https://example.com/a.png" },
      metadata: { room_key: "room-1" },
    });
  });

  test("a ring goes to the voip topic and expires with the invite", async () => {
    const { fetch, calls } = capturingFetch(() => new Response("", { status: 200 }));
    const sender = createApnsVoipSender({
      ...PLACEHOLDER,
      authKey: "x",
      fetch,
      signer: async () => "stub.jwt.sig",
    });
    const res = await sender.ring("voiptoken", {
      callId: "invite-1",
      callerId: "u2",
      callerName: "Sam",
      ttlMs: 45_000,
    });
    expect(res.ok).toBe(true);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["apns-topic"]).toBe("com.example.app.voip");
    expect(headers["apns-push-type"]).toBe("voip");
    expect(headers["apns-priority"]).toBe("10");
    const expiry = Number(headers["apns-expiration"]) * 1000;
    expect(expiry - Date.now()).toBeLessThanOrEqual(46_000);
  });

  test("the probe proves the key without touching a device", async () => {
    const sender = createApnsVoipSender({
      ...PLACEHOLDER,
      authKey: "x",
      logger: recorder().logger,
      signer: async () => "stub.jwt.sig",
      fetch: async () => jsonResponse({ reason: "BadDeviceToken" }, 400),
    });
    const res = await sender.probe();
    expect(res.verdict).toContain("key accepted");
  });

  test("an unconfigured probe says so instead of calling out", async () => {
    let called = false;
    const sender = createApnsVoipSender({
      ...PLACEHOLDER,
      authKey: undefined,
      fetch: async () => {
        called = true;
        return new Response("", { status: 200 });
      },
    });
    const res = await sender.probe();
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
  });
});
