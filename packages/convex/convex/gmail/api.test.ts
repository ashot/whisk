import { describe, expect, test } from "bun:test";
import {
  base64UrlDecode,
  base64UrlEncode,
  buildMimeMessage,
  buildRawMessage,
  collapseHistory,
  decodeEntities,
  encodeHeaderValue,
  formatAddress,
  parseAddress,
  parseAddressList,
  parseGmailMessage,
  queryString,
  walkParts,
  backoffMs,
  googleCall,
  isRateLimited,
} from "./api";
import { isLocalId } from "./pump";
import {
  applyLabelDelta,
  deriveThreadFields,
  normalizeLabels,
  sameLabels,
} from "../lib/threads";
import { matchThread, parseQuery } from "@mail/shared/src/lib/searchQuery";
import { snippetOf } from "../dispatch";

const b64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

describe("encoding", () => {
  test("base64url round-trips unicode", () => {
    for (const text of ["hello", "Presupuesto — identidad", "日本語のテスト", "🚀"]) {
      expect(base64UrlDecode(base64UrlEncode(text))).toBe(text);
    }
  });

  test("base64url output has no padding or unsafe characters", () => {
    const encoded = base64UrlEncode("subjects?with/slashes+and+pluses~~~~");
    expect(encoded).not.toMatch(/[+/=]/);
  });

  test("ASCII headers pass through, non-ASCII becomes an encoded word", () => {
    expect(encodeHeaderValue("Weekly numbers")).toBe("Weekly numbers");
    const encoded = encodeHeaderValue("Presupuesto — identidad");
    expect(encoded).toStartWith("=?UTF-8?B?");
    expect(encoded).toEndWith("?=");
    // The payload is standard base64 of the UTF-8 bytes.
    const payload = encoded.slice("=?UTF-8?B?".length, -"?=".length);
    expect(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))).toBe(
      "Presupuesto — identidad",
    );
  });

  test("display names are quoted or encoded as the header requires", () => {
    expect(formatAddress({ email: "nora@driftwork.io" })).toBe(
      "nora@driftwork.io",
    );
    expect(
      formatAddress({ name: "Nora Adeyemi", email: "nora@driftwork.io" }),
    ).toBe("Nora Adeyemi <nora@driftwork.io>");
    expect(
      formatAddress({ name: "Adeyemi, Nora", email: "nora@driftwork.io" }),
    ).toBe('"Adeyemi, Nora" <nora@driftwork.io>');
    expect(
      formatAddress({ name: "Sofía Marín", email: "sofia@estudiomarin.es" }),
    ).toMatch(/^=\?UTF-8\?B\?.+\?= <sofia@estudiomarin\.es>$/);
  });

  test("query strings drop empty values", () => {
    expect(queryString({ a: "1", b: undefined, c: "", d: 4 })).toBe("?a=1&d=4");
    expect(queryString({})).toBe("");
  });

  test("snippets collapse whitespace and truncate", () => {
    expect(snippetOf("  a\n\n  b  ")).toBe("a b");
    const long = snippetOf("x".repeat(500));
    expect(long).toHaveLength(200);
    expect(long).toEndWith("…");
  });

  test("gmail snippet entities are decoded", () => {
    expect(decodeEntities("Tom &amp; Jerry &quot;quoted&quot; &lt;tag&gt;")).toBe(
      'Tom & Jerry "quoted" <tag>',
    );
  });
});

describe("address parsing", () => {
  test("bare, angled and quoted forms", () => {
    expect(parseAddress("nora@driftwork.io")).toEqual({
      email: "nora@driftwork.io",
    });
    expect(parseAddress("Theo Brandt <theo@driftwork.io>")).toEqual({
      name: "Theo Brandt",
      email: "theo@driftwork.io",
    });
    expect(parseAddress('"Brandt, Theo" <theo@driftwork.io>')).toEqual({
      name: "Brandt, Theo",
      email: "theo@driftwork.io",
    });
    expect(parseAddress("   ")).toBeNull();
  });

  test("a list splits on commas outside quotes", () => {
    const parsed = parseAddressList(
      'Theo Brandt <theo@driftwork.io>, "Raman, Priya" <priya@driftwork.io>, marcus@driftwork.io',
    );
    expect(parsed).toEqual([
      { name: "Theo Brandt", email: "theo@driftwork.io" },
      { name: "Raman, Priya", email: "priya@driftwork.io" },
      { email: "marcus@driftwork.io" },
    ]);
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe("MIME builder", () => {
  const base = {
    from: { name: "Nora Adeyemi", email: "nora@driftwork.io" },
    to: [{ name: "Theo Brandt", email: "theo@driftwork.io" }],
    subject: "Composer v3",
    bodyText: "Capping the backoff at a minute is the right call.",
    date: new Date("2026-08-10T09:15:00Z"),
  };

  test("headers and a base64 body, never quoted-printable", () => {
    const mime = buildMimeMessage(base);
    const [headers, body] = mime.split("\r\n\r\n");
    expect(headers).toContain("From: Nora Adeyemi <nora@driftwork.io>");
    expect(headers).toContain("To: Theo Brandt <theo@driftwork.io>");
    expect(headers).toContain("Subject: Composer v3");
    expect(headers).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(headers).toContain("Content-Transfer-Encoding: base64");
    expect(headers).toContain("MIME-Version: 1.0");
    expect(headers).not.toContain("quoted-printable");
    expect(headers).not.toContain("Cc:");
    expect(headers).not.toContain("In-Reply-To:");
    expect(atob(body.replace(/\r\n/g, ""))).toBe(base.bodyText);
  });

  test("cc, bcc and Message-ID appear only when supplied", () => {
    const mime = buildMimeMessage({
      ...base,
      cc: [{ email: "priya@driftwork.io" }],
      bcc: [{ email: "marcus@driftwork.io" }],
      messageId: "<compose-1@mail.local>",
    });
    expect(mime).toContain("Cc: priya@driftwork.io");
    expect(mime).toContain("Bcc: marcus@driftwork.io");
    expect(mime).toContain("Message-ID: <compose-1@mail.local>");
  });

  test("a reply carries both In-Reply-To and References", () => {
    const mime = buildMimeMessage({
      ...base,
      inReplyTo: "<demo-02-08@mail.local>",
      references: "<demo-02-01@mail.local> <demo-02-08@mail.local>",
    });
    expect(mime).toContain("In-Reply-To: <demo-02-08@mail.local>");
    expect(mime).toContain(
      "References: <demo-02-01@mail.local> <demo-02-08@mail.local>",
    );
  });

  test("a unicode subject is an encoded word and the body survives", () => {
    const mime = buildMimeMessage({
      ...base,
      subject: "Presupuesto — identidad",
      bodyText: "Un abrazo, Sofía. 日本語も。",
    });
    expect(mime).toContain(`Subject: ${encodeHeaderValue("Presupuesto — identidad")}`);
    const body = mime.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(
      new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))),
    ).toBe("Un abrazo, Sofía. 日本語も。");
  });

  test("long bodies wrap at 76 columns", () => {
    const mime = buildMimeMessage({ ...base, bodyText: "x".repeat(400) });
    const lines = mime.split("\r\n\r\n")[1].split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
  });

  test("the raw field is base64url of the whole message", () => {
    const raw = buildRawMessage(base);
    expect(raw).not.toMatch(/[+/=]/);
    expect(base64UrlDecode(raw)).toBe(buildMimeMessage(base));
  });

  test("files make it multipart/mixed: text first, each file its own base64 part", () => {
    const mime = buildMimeMessage({
      ...base,
      attachments: [
        { filename: 'notes "final".txt', mimeType: "text/plain; charset=utf-8", bytes: new TextEncoder().encode("hello") },
        { filename: "deck.pdf", mimeType: "application/pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
      ],
    });
    const boundary = mime.match(/multipart\/mixed; boundary="([^"]+)"/)?.[1];
    expect(boundary).toBeTruthy();
    const parts = mime.split(`--${boundary}`);
    // Preamble, text, two files, and the closing "--".
    expect(parts).toHaveLength(5);
    expect(parts[1]).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(parts[1]).toContain(btoa(base.bodyText).slice(0, 20));
    expect(parts[2]).toContain('Content-Disposition: attachment; filename="notes _final_.txt"');
    expect(parts[2]).toContain("Content-Type: text/plain; name=");
    expect(parts[2]).toContain(btoa("hello"));
    expect(parts[3]).toContain('Content-Type: application/pdf; name="deck.pdf"');
    expect(parts[3]).toContain(btoa("%PDF"));
    expect(parts[4].trim()).toBe("--");
    // The wire form stays base64url of exactly this text.
    expect(base64UrlDecode(buildRawMessage({ ...base, attachments: [] }))).toBe(buildMimeMessage(base));
  });
});

describe("payload parsing", () => {
  const message = {
    id: "18f2c",
    threadId: "18f2b",
    labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
    snippet: "Reproduced. The retry path rebuilds the request &amp; drops it",
    internalDate: "1754820900000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Theo Brandt <theo@driftwork.io>" },
        { name: "To", value: "Nora Adeyemi <nora@driftwork.io>, priya@driftwork.io" },
        { name: "Cc", value: "marcus@driftwork.io" },
        { name: "Reply-To", value: "Theo <theo+replies@driftwork.io>" },
        { name: "Subject", value: "Composer drops attachments on retry" },
        { name: "Date", value: "Sun, 10 Aug 2026 09:15:00 +0000" },
        { name: "Message-ID", value: "<abc@driftwork.io>" },
        { name: "In-Reply-To", value: "<parent@driftwork.io>" },
        { name: "References", value: "<root@driftwork.io> <parent@driftwork.io>" },
      ],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { size: 20, data: b64("plain body") } },
            {
              mimeType: "text/html",
              body: { size: 40, data: b64("<p>html body</p>") },
            },
          ],
        },
        {
          mimeType: "application/pdf",
          filename: "invoice.pdf",
          body: { size: 148204, attachmentId: "ANGjdJ_att_1" },
        },
      ],
    },
  };

  test("bodies and attachments come out of a nested tree", () => {
    const walked = walkParts(message.payload);
    expect(walked.text).toBe("plain body");
    expect(walked.html).toBe("<p>html body</p>");
    expect(walked.attachments).toEqual([
      {
        filename: "invoice.pdf",
        mime_type: "application/pdf",
        size: 148204,
        gmail_attachment_id: "ANGjdJ_att_1",
      },
    ]);
  });

  test("a full message maps onto a row", () => {
    const parsed = parseGmailMessage(message);
    expect(parsed.gmail_id).toBe("18f2c");
    expect(parsed.thread_gmail_id).toBe("18f2b");
    expect(parsed.from).toEqual({
      name: "Theo Brandt",
      email: "theo@driftwork.io",
    });
    expect(parsed.to).toHaveLength(2);
    expect(parsed.cc).toEqual([{ email: "marcus@driftwork.io" }]);
    expect(parsed.reply_to?.email).toBe("theo+replies@driftwork.io");
    expect(parsed.date).toBe(1754820900000);
    expect(parsed.is_unread).toBe(true);
    // Gmail sends ["INBOX","UNREAD","IMPORTANT"]; rows store canonical order.
    expect(parsed.label_ids).toEqual(["IMPORTANT", "INBOX", "UNREAD"]);
    expect(parsed.subject).toBe("Composer drops attachments on retry");
    expect(parsed.header_message_id).toBe("<abc@driftwork.io>");
    expect(parsed.in_reply_to).toBe("<parent@driftwork.io>");
    expect(parsed.references).toContain("<root@driftwork.io>");
    expect(parsed.snippet).toBe(
      "Reproduced. The retry path rebuilds the request & drops it",
    );
    // Raw HTML is stored as received; sanitising is the client's job.
    expect(parsed.body_html).toBe("<p>html body</p>");
  });

  test("a bare single-part message still parses", () => {
    const parsed = parseGmailMessage({
      id: "1",
      threadId: "1",
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "From", value: "noreply@example.com" }],
        body: { size: 5, data: b64("hello") },
      },
    });
    expect(parsed.body_text).toBe("hello");
    expect(parsed.body_html).toBeUndefined();
    expect(parsed.from).toEqual({ email: "noreply@example.com" });
    expect(parsed.is_unread).toBe(false);
    expect(parsed.attachments).toEqual([]);
    // No internalDate and no Date header falls back to now rather than NaN.
    expect(Number.isFinite(parsed.date)).toBe(true);
  });

  test("headers are matched case-insensitively", () => {
    const parsed = parseGmailMessage({
      id: "2",
      threadId: "2",
      payload: {
        headers: [
          { name: "FROM", value: "a@b.c" },
          { name: "message-id", value: "<x@y>" },
        ],
      },
    });
    expect(parsed.from.email).toBe("a@b.c");
    expect(parsed.header_message_id).toBe("<x@y>");
  });
});

describe("history collapse", () => {
  const msg = (id: string, threadId = "t1") => ({ id, threadId });

  test("additions and deletions are collected once each", () => {
    const effect = collapseHistory({
      history: [
        { id: "1", messagesAdded: [{ message: msg("m1") }] },
        { id: "2", messagesAdded: [{ message: msg("m1") }] },
        { id: "3", messagesAdded: [{ message: msg("m2") }] },
        { id: "4", messagesDeleted: [{ message: msg("m3") }] },
      ],
    });
    expect(effect.added.map((m) => m.messageId)).toEqual(["m1", "m2"]);
    expect(effect.deleted.map((m) => m.messageId)).toEqual(["m3"]);
  });

  test("label changes net out in page order", () => {
    const effect = collapseHistory({
      history: [
        { id: "1", labelsAdded: [{ message: msg("m1"), labelIds: ["STARRED", "UNREAD"] }] },
        { id: "2", labelsRemoved: [{ message: msg("m1"), labelIds: ["UNREAD"] }] },
        { id: "3", labelsRemoved: [{ message: msg("m2"), labelIds: ["INBOX"] }] },
        { id: "4", labelsAdded: [{ message: msg("m2"), labelIds: ["INBOX"] }] },
      ],
    });
    const first = effect.labelChanges.get("m1")!;
    expect([...first.add]).toEqual(["STARRED"]);
    expect([...first.remove]).toEqual(["UNREAD"]);

    // Removed then re-added is a net add, not both.
    const second = effect.labelChanges.get("m2")!;
    expect([...second.add]).toEqual(["INBOX"]);
    expect([...second.remove]).toEqual([]);
  });

  test("a message deleted in the same page needs no other work", () => {
    const effect = collapseHistory({
      history: [
        { id: "1", messagesAdded: [{ message: msg("m1") }] },
        { id: "2", labelsAdded: [{ message: msg("m1"), labelIds: ["STARRED"] }] },
        { id: "3", messagesDeleted: [{ message: msg("m1") }] },
      ],
    });
    expect(effect.added).toEqual([]);
    expect(effect.deleted.map((m) => m.messageId)).toEqual(["m1"]);
    expect(effect.labelChanges.size).toBe(0);
  });

  test("a fetched message needs no separate label work", () => {
    const effect = collapseHistory({
      history: [
        { id: "1", messagesAdded: [{ message: msg("m1") }] },
        { id: "2", labelsAdded: [{ message: msg("m1"), labelIds: ["STARRED"] }] },
      ],
    });
    expect(effect.added.map((m) => m.messageId)).toEqual(["m1"]);
    expect(effect.labelChanges.size).toBe(0);
  });

  test("an empty page is an empty effect", () => {
    const effect = collapseHistory({});
    expect(effect.added).toEqual([]);
    expect(effect.deleted).toEqual([]);
    expect(effect.labelChanges.size).toBe(0);
  });
});

describe("label and thread derivation", () => {
  test("the canonical form is deduplicated and sorted", () => {
    expect(normalizeLabels(["UNREAD", "INBOX", "UNREAD", "STARRED"])).toEqual([
      "INBOX",
      "STARRED",
      "UNREAD",
    ]);
    expect(normalizeLabels([])).toEqual([]);
    // Equal sets are equal arrays whatever order they arrived in — which is
    // what lets the client's pending write retire against the server echo.
    expect(normalizeLabels(["b", "a"])).toEqual(normalizeLabels(["a", "b"]));
  });

  test("a delta adds, removes and always returns the canonical form", () => {
    expect(applyLabelDelta(["INBOX", "UNREAD"], ["STARRED"], ["UNREAD"])).toEqual([
      "INBOX",
      "STARRED",
    ]);
    // Adding what is already there changes nothing.
    expect(applyLabelDelta(["INBOX"], ["INBOX"], [])).toEqual(["INBOX"]);
    // Remove wins over add in the same delta.
    expect(applyLabelDelta(["INBOX"], ["UNREAD"], ["UNREAD"])).toEqual(["INBOX"]);
    // An unsorted starting point is sorted on the way out.
    expect(applyLabelDelta(["UNREAD", "INBOX"], ["SENT"], [])).toEqual([
      "INBOX",
      "SENT",
      "UNREAD",
    ]);
    expect(sameLabels(applyLabelDelta(["A", "B"], [], []), ["A", "B"])).toBe(true);
  });

  test("thread fields are the union and the extremes of their messages", () => {
    const message = (over: Record<string, unknown>) =>
      ({
        from: { name: "Theo Brandt", email: "theo@driftwork.io" },
        date: 1,
        snippet: "",
        label_ids: [],
        is_unread: false,
        attachments: [],
        ...over,
      }) as any;

    const derived = deriveThreadFields([
      message({ date: 300, snippet: "last", label_ids: ["SENT"] }),
      message({
        date: 100,
        snippet: "first",
        label_ids: ["INBOX", "STARRED"],
        from: { name: "Priya Raman", email: "priya@driftwork.io" },
      }),
      message({
        date: 200,
        snippet: "middle",
        is_unread: true,
        label_ids: ["INBOX", "UNREAD"],
        attachments: [{ filename: "a.pdf" }],
      }),
    ]);

    expect(derived.message_count).toBe(3);
    expect(derived.last_at).toBe(300);
    expect(derived.snippet).toBe("last");
    // The union of the messages' labels, in canonical order.
    expect(derived.label_ids).toEqual(["INBOX", "SENT", "STARRED", "UNREAD"]);
    expect(derived.is_unread).toBe(true);
    expect(derived.is_starred).toBe(true);
    expect(derived.has_attachments).toBe(true);
    // Senders in date order, deduplicated.
    expect(derived.participants.map((p) => p.email)).toEqual([
      "priya@driftwork.io",
      "theo@driftwork.io",
    ]);
  });

  test("an empty thread derives empty rather than throwing", () => {
    const derived = deriveThreadFields([]);
    expect(derived.message_count).toBe(0);
    expect(derived.last_at).toBe(0);
    expect(derived.is_unread).toBe(false);
  });
});

describe("search parsing", () => {
  test("operators split out of the free text", () => {
    const parsed = parseQuery('from:hannah  label:Receipts is:unread "board deck" lisbon');
    expect(parsed.from).toEqual(["hannah"]);
    expect(parsed.labels).toEqual(["receipts"]);
    expect(parsed.isUnread).toBe(true);
    expect(parsed.terms).toEqual(["board deck", "lisbon"]);
    expect(parsed.isStarred).toBe(false);
  });

  test("matching is conjunctive across fields", () => {
    const thread = {
      subject: "Your trip to Lisbon is confirmed",
      snippet: "Booking reference QK7T2M",
      participants: [{ name: "Aerial Airways", email: "itinerary@aerialairways.com" }],
      label_ids: ["INBOX", "Label_Travel"],
      is_unread: false,
      is_starred: false,
      has_attachments: false,
    };
    expect(matchThread(thread, parseQuery("lisbon booking"))).toBe(true);
    expect(matchThread(thread, parseQuery("lisbon porto"))).toBe(false);
    expect(matchThread(thread, parseQuery("from:aerial"))).toBe(true);
    expect(matchThread(thread, parseQuery("is:unread lisbon"))).toBe(false);
    expect(matchThread(thread, parseQuery("has:attachment"))).toBe(false);
    // A label matches by id or by display name.
    const names = new Map([["Label_Travel", "Travel"]]);
    expect(matchThread(thread, parseQuery("label:travel"), names)).toBe(true);
    expect(matchThread(thread, parseQuery("label:label_travel"), names)).toBe(true);
    expect(matchThread(thread, parseQuery("label:receipts"), names)).toBe(false);
  });
});

describe("pump helpers", () => {
  test("locally minted ids are recognised", () => {
    expect(isLocalId("local-msg-compose-1")).toBe(true);
    expect(isLocalId("local-thread-compose-1")).toBe(true);
    expect(isLocalId("18f2c9a")).toBe(false);
  });

  test("backoff grows and then caps at a minute", () => {
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(2)).toBe(4_000);
    expect(backoffMs(3)).toBe(8_000);
    expect(backoffMs(10)).toBe(60_000);
  });
});

describe("googleCall", () => {
  test("a rate-limited call is retried, other failures are not", async () => {
    const original = globalThis.fetch;
    const answers: Array<{ status: number; body: string; headers?: Record<string, string> }> = [];
    let calls = 0;
    globalThis.fetch = (async () => {
      const next = answers[Math.min(calls++, answers.length - 1)];
      return new Response(next.body, { status: next.status, headers: next.headers });
    }) as typeof fetch;
    try {
      answers.push(
        // Retry-After: 0 keeps the test instant and proves the header wins over backoff.
        { status: 403, body: JSON.stringify({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }), headers: { "Retry-After": "0" } },
        { status: 429, body: "slow down", headers: { "Retry-After": "0" } },
        { status: 200, body: JSON.stringify({ ok: true }) },
      );
      expect(await googleCall("tok", "https://example.test/x")).toEqual({ ok: true });
      expect(calls).toBe(3);

      answers.length = 0;
      calls = 0;
      answers.push({ status: 403, body: JSON.stringify({ error: { message: "insufficient scopes" } }) });
      await expect(googleCall("tok", "https://example.test/x")).rejects.toThrow("failed (403): insufficient scopes");
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
    expect(isRateLimited(403, "rateLimitExceeded")).toBe(true);
    expect(isRateLimited(403, "forbidden")).toBe(false);
    expect(isRateLimited(429, "")).toBe(true);
  });
});
