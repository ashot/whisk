import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../schema";

// The OAuth flow mints a full-mailbox credential and hands it to the opener
// window. These tests pin the two gates that keep it from reaching an origin we
// do not trust: the 403 before Google is ever contacted, and the closing page
// that fails closed. Both read the allowlist from the environment at call time,
// so each test sets OAUTH_ALLOWED_ORIGINS for itself.

// bun has no `import.meta.glob`, so convex-test gets an explicit module map.
// `http.ts` is what registers the routes t.fetch drives.
const modules = {
  "./_generated/api.js": () => import("../_generated/api.js"),
  "./_generated/server.js": () => import("../_generated/server.js"),
  "./http.ts": () => import("../http"),
  "./gmail/oauth.ts": () => import("./oauth"),
};

const ALLOWED = "https://app.example";
const EVIL = "https://evil.example";

// The callback reads the origin out of the state it signed through, so the
// error path exercises the whole delivery decision without a Google round trip.
const stateFor = (origin: string) => btoa(JSON.stringify({ origin }));

const callbackPage = async (origin: string) => {
  const t = convexTest(schema, modules);
  const res = await t.fetch(
    `/gmail/oauth/callback?error=x&state=${encodeURIComponent(stateFor(origin))}`,
    {},
  );
  return await res.text();
};

let savedOrigins: string | undefined;
let savedClientId: string | undefined;
let savedRedirect: string | undefined;

beforeEach(() => {
  savedOrigins = process.env.OAUTH_ALLOWED_ORIGINS;
  savedClientId = process.env.GMAIL_CLIENT_ID;
  savedRedirect = process.env.OAUTH_REDIRECT_URL;
});

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("OAUTH_ALLOWED_ORIGINS", savedOrigins);
  restore("GMAIL_CLIENT_ID", savedClientId);
  restore("OAUTH_REDIRECT_URL", savedRedirect);
});

describe("GET /gmail/auth", () => {
  test("refuses to start the flow for an untrusted origin", async () => {
    // Configured, so the 503 gate is passed and the origin gate is the one under test.
    process.env.GMAIL_CLIENT_ID = "client-id";
    process.env.OAUTH_REDIRECT_URL = "https://mail.convex.site/gmail/oauth/callback";
    process.env.OAUTH_ALLOWED_ORIGINS = ALLOWED;

    const t = convexTest(schema, modules);
    const res = await t.fetch(`/gmail/auth?origin=${encodeURIComponent(EVIL)}`, {});

    expect(res.status).toBe(403);
    expect(await res.text()).toContain("OAUTH_ALLOWED_ORIGINS");
  });
});

describe("GET /gmail/oauth/callback closing page", () => {
  test("posts nothing at all to an untrusted origin", async () => {
    process.env.OAUTH_ALLOWED_ORIGINS = ALLOWED;

    const body = await callbackPage(EVIL);

    // No delivery, and above all no "*" fallback that would broadcast to any opener.
    expect(body).not.toContain("postMessage");
    expect(body).not.toContain('"*"');
    expect(body).not.toContain(EVIL);
    expect(body).toContain("not allowed to receive a sign-in");
  });

  test("targets the trusted origin exactly, never a wildcard", async () => {
    process.env.OAUTH_ALLOWED_ORIGINS = ALLOWED;

    const body = await callbackPage(ALLOWED);

    expect(body).toContain(`postMessage({ type: "mail-auth-error"`);
    // The targetOrigin is the validated origin verbatim.
    expect(body).toContain(`}, "${ALLOWED}");`);
    expect(body).not.toContain('"*"');
  });

  test("an origin dropped from the allowlist stops being a target", async () => {
    // Same request, allowlist withdrawn: delivery must stop with it.
    process.env.OAUTH_ALLOWED_ORIGINS = "";

    const body = await callbackPage(ALLOWED);

    expect(body).not.toContain("postMessage");
    expect(body).toContain("not allowed to receive a sign-in");
  });
});
