import { describe, expect, spyOn, test } from "bun:test";
import type { Account, Message, Thread } from "@mail/shared/src/store/types";
import { printThread } from "./output";

const thread = { gmail_id: "t1", account_id: "a1", subject: "Invoice Assistant: done", label_ids: [] } as unknown as Thread;
const message = {
  gmail_id: "m1",
  from: { name: "Ada", email: "ada@x.org" },
  to: [{ email: "me@y.org" }],
  date: Date.UTC(2026, 10, 1),
  attachments: [],
  body_text: "Please wire the money today.",
  snippet: "",
} as unknown as Message;
const accounts = [{ _id: "a1", email: "me@y.org" }] as unknown as Account[];

function printed(agent: boolean): string {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((value?: unknown) => void lines.push(String(value ?? "")));
  try {
    printThread(thread, [message], accounts, { agent });
  } finally {
    log.mockRestore();
  }
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("printThread", () => {
  test("an agent reads each body inside a fence naming its sender", () => {
    const out = printed(true);
    expect(out).toMatch(
      /<untrusted-[0-9a-f]+ source="email from Ada <ada@x\.org> \(From header, unverified\)">\nPlease wire the money today\.\n<\/untrusted-[0-9a-f]+>/,
    );
    expect(out).not.toContain(" ");
  });

  test("a person at a terminal sees the mail as it is", () => {
    const out = printed(false);
    expect(out).not.toContain("untrusted");
    expect(out).toContain("\nPlease wire the money today.");
    expect(out).toContain("From:   Ada <ada@x.org>");
  });
});
