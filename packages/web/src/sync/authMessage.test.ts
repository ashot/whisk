import { describe, expect, test } from "bun:test";
import { readAuthMessage } from "./authMessage";

const SITE = "https://mail.convex.site";
const EVIL = "https://evil.example";

describe("readAuthMessage", () => {
  test("accepts a token from the Convex site origin", () => {
    const msg = readAuthMessage({ origin: SITE, data: { type: "mail-auth", token: "atk" } }, SITE);
    expect(msg).toEqual({ kind: "token", token: "atk" });
  });

  test("ignores a token from any other origin", () => {
    const msg = readAuthMessage({ origin: EVIL, data: { type: "mail-auth", token: "atk" } }, SITE);
    expect(msg).toBeNull();
  });

  // The regression: an unset VITE_CONVEX_SITE_URL used to skip the origin check
  // entirely, so any page holding a handle to this window could post a token and
  // fix the session onto a mailbox it controls.
  test("ignores every token when no origin is configured", () => {
    for (const origin of [EVIL, SITE]) {
      expect(readAuthMessage({ origin, data: { type: "mail-auth", token: "atk" } }, null)).toBeNull();
    }
  });

  test("ignores an attach notice when no origin is configured", () => {
    expect(readAuthMessage({ origin: EVIL, data: { type: "mail-auth-attached" } }, null)).toBeNull();
  });

  test("accepts an attach notice only from the Convex site origin", () => {
    expect(readAuthMessage({ origin: SITE, data: { type: "mail-auth-attached" } }, SITE))
      .toEqual({ kind: "attached" });
    expect(readAuthMessage({ origin: EVIL, data: { type: "mail-auth-attached" } }, SITE))
      .toBeNull();
  });

  test("ignores anything that is not one of the two shapes", () => {
    const junk: unknown[] = [
      null,
      "mail-auth",
      { type: "mail-auth" },
      { type: "mail-auth", token: "" },
      { type: "mail-auth", token: 42 },
      { type: "something-else", token: "atk" },
    ];
    for (const data of junk) {
      expect(readAuthMessage({ origin: SITE, data }, SITE)).toBeNull();
    }
  });
});
