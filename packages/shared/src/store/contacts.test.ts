import { describe, expect, test } from "bun:test";
import { contactIndex, isMachineAddress, suggestContacts } from "./contacts";
import { L, type Account, type Message, type Thread } from "./types";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

let seq = 0;
function thread(participants: Thread["participants"], labels: string[] = [L.INBOX], lastAt = NOW): Thread {
  seq++;
  return {
    _id: `t${seq}`,
    account_id: "acct",
    gmail_id: `g${seq}`,
    subject: "s",
    snippet: "",
    participants,
    message_count: 1,
    last_at: lastAt,
    label_ids: labels,
    is_unread: false,
    is_starred: false,
    has_attachments: false,
    updated_at: lastAt,
  };
}

function message(from: Message["from"], to: Message["to"], date = NOW): Message {
  seq++;
  return {
    _id: `m${seq}`,
    account_id: "acct",
    thread_gmail_id: "g1",
    gmail_id: `mg${seq}`,
    from,
    to,
    date,
    snippet: "",
    label_ids: [],
    is_unread: false,
    attachments: [],
    updated_at: date,
  };
}

const accounts: Record<string, Account> = {
  acct: { _id: "acct", email: "me@example.com" } as Account,
};

describe("contactIndex", () => {
  test("gathers participants and message addresses, never the user", () => {
    const threads = {
      a: thread([{ name: "Ada Lovelace", email: "ada@example.com" }, { email: "me@example.com" }]),
    };
    const messages = { g1: [message({ email: "ME@example.com" }, [{ name: "Grace Hopper", email: "grace@navy.mil" }])] };
    const index = contactIndex(threads, messages, accounts, NOW);
    expect(index.map((c) => c.email)).toEqual(expect.arrayContaining(["ada@example.com", "grace@navy.mil"]));
    expect(index.some((c) => c.email === "me@example.com")).toBe(false);
  });

  test("people you wrote to outrank people who only wrote to you", () => {
    const threads = {
      a: thread([{ email: "noisy@list.com" }]),
      b: thread([{ email: "noisy@list.com" }]),
      c: thread([{ email: "friend@example.com" }], [L.SENT]),
    };
    const index = contactIndex(threads, {}, accounts, NOW);
    expect(index[0].email).toBe("friend@example.com");
  });

  test("old mail fades; the newest name wins", () => {
    const threads = {
      old: thread([{ name: "A. Person", email: "a@x.com" }], [L.INBOX], NOW - 400 * DAY),
      newer: thread([{ name: "Alex Person", email: "a@x.com" }], [L.INBOX], NOW - DAY),
      fresh: thread([{ email: "b@x.com" }], [L.INBOX], NOW),
    };
    const index = contactIndex(threads, {}, accounts, NOW);
    const a = index.find((c) => c.email === "a@x.com")!;
    expect(a.name).toBe("Alex Person");
    expect(a.score).toBeGreaterThan(1);
    expect(a.score).toBeLessThan(2);
  });

  test("is memoized on the store collections", () => {
    const threads = { a: thread([{ email: "a@x.com" }]) };
    const messages = {};
    const first = contactIndex(threads, messages, accounts, NOW);
    expect(contactIndex(threads, messages, accounts, NOW)).toBe(first);
    expect(contactIndex({ ...threads }, messages, accounts, NOW)).not.toBe(first);
  });
});

describe("isMachineAddress", () => {
  test("unattended senders and per-conversation relay addresses are noise", () => {
    expect(isMachineAddress("noreply@github.com")).toBe(true);
    expect(isMachineAddress("no-reply+x@stripe.com")).toBe(true);
    expect(isMachineAddress("notifications@slack.com")).toBe(true);
    expect(isMachineAddress("5a4669db21dc35539e28dade06814475@reply.craigslist.org")).toBe(true);
    expect(isMachineAddress("ada@example.com")).toBe(false);
    expect(isMachineAddress("first.middle.lastname.very.long@example.com")).toBe(false);
    expect(isMachineAddress("notify.me@example.com")).toBe(false);
  });
});

describe("suggestContacts", () => {
  const index = [
    { email: "ada@example.com", name: "Ada Lovelace", score: 5 },
    { email: "grace@navy.mil", name: "Grace Hopper", score: 9 },
    { email: "lin@example.com", name: "Linus Torvalds", score: 2 },
    { email: "x@adamant.io", name: "Rex", score: 20 },
  ];

  test("prefix of address or name beats a later word, which beats the domain", () => {
    expect(suggestContacts(index, "ad").map((c) => c.email)).toEqual(["ada@example.com", "x@adamant.io"]);
    expect(suggestContacts(index, "hop").map((c) => c.email)).toEqual(["grace@navy.mil"]);
    expect(suggestContacts(index, "example").map((c) => c.email)).toEqual(["ada@example.com", "lin@example.com"]);
  });

  test("an empty query lists the most written to first, minus who is already added", () => {
    expect(suggestContacts(index, "", ["x@adamant.io"], 2).map((c) => c.email)).toEqual(["grace@navy.mil", "ada@example.com"]);
  });

  test("no match, no rows", () => {
    expect(suggestContacts(index, "zzz")).toEqual([]);
  });
});
