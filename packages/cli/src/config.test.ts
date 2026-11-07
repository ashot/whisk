import { describe, expect, test } from "bun:test";
import { threadLink } from "./config";

describe("threadLink", () => {
  test("builds the app link from the id with no lookup", () => {
    process.env.WHISK_WEB_URL = "https://whisk.email";
    expect(threadLink(" 19a1b2c3d4e5f6a7 ")).toBe("https://whisk.email/#t/19a1b2c3d4e5f6a7");
    expect(threadLink("a/b")).toBe("https://whisk.email/#t/a%2Fb");
  });
});
