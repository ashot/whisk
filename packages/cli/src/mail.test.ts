import { describe, expect, test } from "bun:test";
import { gmailQueryForList, type ListOptions } from "./mail";

const base: ListOptions = { view: "inbox", accounts: [], limit: 25 };

describe("gmailQueryForList", () => {
  test("views Gmail knows become queries; Whisk-only views do not", () => {
    expect(gmailQueryForList({ ...base, view: "sent" })).toBe("in:sent");
    expect(gmailQueryForList({ ...base, view: "archive" })).toBe("-in:inbox -in:drafts");
    expect(gmailQueryForList({ ...base, view: "cat:newsletters" })).toBeNull();
    expect(gmailQueryForList({ ...base, view: "later" })).toBeNull();
  });

  test("labels in Gmail's query spelling", () => {
    const labels = [{ gmail_id: "Label_7", name: "[Superhuman]/AI/Deal Flow" }] as ListOptions["labels"];
    expect(gmailQueryForList({ ...base, view: "label:Label_7", labels })).toBe("label:[superhuman]/ai/deal-flow");
    expect(gmailQueryForList({ ...base, view: "label:Label_9", labels })).toBeNull();
  });

  test("flags carry over", () => {
    const q = gmailQueryForList({ ...base, view: "sent", unread: true, attachments: true, from: "Ada Lovelace" });
    expect(q).toBe('in:sent is:unread has:attachment {from:"Ada Lovelace" to:"Ada Lovelace" cc:"Ada Lovelace"}');
    expect(gmailQueryForList({ ...base, since: "2026-01-01" })).toMatch(/^in:inbox after:\d+$/);
  });
});
