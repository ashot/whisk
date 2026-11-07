import { expect, test } from "bun:test";
import { addRecipients, composeLabels, parseAddresses, seedCompose } from "./compose";
import type { Message } from "../store/types";

function msg(overrides: Partial<Message> = {}): Message {
  return {
    _id: "m1",
    account_id: "acct",
    thread_gmail_id: "t1",
    gmail_id: "g1",
    from: { name: "Ada", email: "ada@example.com" },
    to: [{ email: "me@example.com" }],
    date: 1,
    snippet: "hi",
    body_text: "hello there",
    label_ids: [],
    is_unread: false,
    attachments: [],
    updated_at: 1,
    ...overrides,
  };
}

test("a reply goes to the last inbound sender", () => {
  const seed = seedCompose({
    mode: "reply",
    threadGmailId: "t1",
    baseSubject: "Lease",
    messages: [msg()],
    me: { email: "me@example.com" },
  });
  expect(seed.to).toEqual([{ name: "Ada", email: "ada@example.com" }]);
  expect(seed.subject).toBe("Re: Lease");
  expect(seed.thread_gmail_id).toBe("t1");
  expect(seed.attachments).toBeUndefined();
});

test("a forward quotes the message and takes its files along", () => {
  const seed = seedCompose({
    mode: "forward",
    threadGmailId: "t1",
    baseSubject: "Lease",
    messages: [
      msg({
        attachments: [
          { filename: "lease.pdf", mime_type: "application/pdf", size: 1200, gmail_attachment_id: "att-1" },
        ],
      }),
    ],
    me: { email: "me@example.com" },
  });
  expect(seed.to).toEqual([]);
  expect(seed.subject).toBe("Fwd: Lease");
  expect(seed.thread_gmail_id).toBe("t1");
  expect(seed.reply_to_gmail_id).toBe("g1");
  expect(seed.body_text).toContain("Forwarded message");
  expect(seed.body_text).toContain("hello there");
  expect(seed.attachments).toEqual([
    {
      filename: "lease.pdf",
      mime_type: "application/pdf",
      size: 1200,
      message_gmail_id: "g1",
      gmail_attachment_id: "att-1",
    },
  ]);
});

test("a forward with no files does not set attachments", () => {
  const seed = seedCompose({
    mode: "forward",
    threadGmailId: "t1",
    baseSubject: "Hi",
    messages: [msg()],
  });
  expect(seed.attachments).toBeUndefined();
});

const aliased = {
  email: "me@gmail.com",
  name: "Me",
  send_as: [
    { email: "me@gmail.com" },
    { email: "me@work.com", name: "Me at Work", is_default: true },
  ],
};

test("a reply goes out from the address the mail was sent to", () => {
  const seed = seedCompose({
    mode: "reply",
    threadGmailId: "t1",
    baseSubject: "Lease",
    messages: [msg({ to: [{ email: "ME@gmail.com" }] })],
    me: aliased,
  });
  expect(seed.from).toBe("me@gmail.com");
});

test("a reply to mail that named none of my addresses takes the default", () => {
  const seed = seedCompose({
    mode: "reply",
    threadGmailId: "t1",
    baseSubject: "Lease",
    messages: [msg({ to: [{ email: "list@example.com" }] })],
    me: aliased,
  });
  expect(seed.from).toBeUndefined();
});

test("reply-all drops every one of my addresses", () => {
  const seed = seedCompose({
    mode: "replyAll",
    threadGmailId: "t1",
    baseSubject: "Lease",
    messages: [
      msg({ to: [{ email: "me@work.com" }, { email: "bo@example.com" }], cc: [{ email: "me@gmail.com" }] }),
    ],
    me: aliased,
  });
  expect(seed.to.map((a) => a.email)).toEqual(["ada@example.com", "bo@example.com"]);
  expect(seed.from).toBe("me@work.com");
});

test("my own message sent from an alias is not the one a reply answers", () => {
  const seed = seedCompose({
    mode: "reply",
    threadGmailId: "t1",
    baseSubject: "Lease",
    messages: [
      msg(),
      msg({ gmail_id: "g2", from: { email: "me@work.com" }, to: [{ email: "ada@example.com" }] }),
    ],
    me: aliased,
  });
  expect(seed.reply_to_gmail_id).toBe("g1");
});

test("recipients parse as people type them, and the rest is named", () => {
  expect(parseAddresses('Ada Lovelace <Ada@X.org>, grace@y.org; nope')).toEqual({
    addresses: [{ name: "Ada Lovelace", email: "ada@x.org" }, { email: "grace@y.org" }],
    invalid: ["nope"],
  });
});

test("adding recipients keeps each address once", () => {
  const list = [{ email: "ada@x.org" }];
  expect(addRecipients(list, [{ email: "ada@x.org" }])).toBe(list);
  expect(addRecipients(list, [{ email: "b@y.org" }, { email: "b@y.org" }])).toEqual([
    { email: "ada@x.org" },
    { email: "b@y.org" },
  ]);
});

test("a forward composes as one", () => {
  expect(composeLabels("forward")).toEqual({ title: "Forward", verb: "Forward to" });
  expect(composeLabels("replyAll").verb).toBe("Reply all to");
});
