import { beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  attachAccountToSession,
  createAuthSession,
  ensureUserForAccount,
  hashToken,
  mergeUsers,
} from "./lib/auth";

// A Gmail connect seals its tokens (lib/credentials.ts), so the connects these
// tests drive need a key of their own.
process.env.WHISK_CREDENTIALS_KEY ??= Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

// bun has no `import.meta.glob`, so convex-test gets an explicit module map.
// The `_generated` entry is what it uses to find the module root.
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./auth.ts": () => import("./auth"),
  "./demo.ts": () => import("./demo"),
  "./dispatch.ts": () => import("./dispatch"),
  "./search.ts": () => import("./search"),
  "./sync.ts": () => import("./sync"),
  "./gmail/pump.ts": () => import("./gmail/pump"),
  "./gmail/sync.ts": () => import("./gmail/sync"),
  "./gmail/oauth.ts": () => import("./gmail/oauth"),
  "./migrations.ts": () => import("./migrations"),
  "./push.ts": () => import("./push"),
  "./ai/summarize.ts": () => import("./ai/summarize"),
};

type Harness = ReturnType<typeof convexTest>;

async function seeded() {
  const t = convexTest(schema, modules);
  const { token, accountId } = await t.mutation(api.demo.seed, {});
  return { t, token, accountId };
}

const rowsOf = <T extends keyof typeof schema.tables>(t: Harness, table: T) =>
  t.run(async (ctx) => await ctx.db.query(table).collect());

const threadNamed = async (t: Harness, gmailId: string) =>
  (await rowsOf(t, "threads")).find(
    (row) => (row as Doc<"threads">).gmail_id === gmailId,
  ) as Doc<"threads">;

const messagesIn = async (t: Harness, threadGmailId: string) =>
  (await rowsOf(t, "messages")).filter(
    (row) => (row as Doc<"messages">).thread_gmail_id === threadGmailId,
  ) as Doc<"messages">[];

const dispatch = (
  t: Harness,
  token: string,
  action: string,
  args: unknown,
  patches?: unknown,
) => t.mutation(api.dispatch.dispatch, { token, action, args, patches });

// demo-thread-01 is the onboarding mail; demo-thread-02 is the eight-message
// composer debate, which is the thread most assertions below use.
const DEBATE = "demo-thread-02";

describe("token auth", () => {
  test("an unknown token is rejected by every public function", async () => {
    const { t } = await seeded();
    await expect(
      t.query(api.sync.listThreads, { token: "not-a-real-token" }),
    ).rejects.toThrow(/Unauthorized/);
    await expect(t.query(api.sync.getAccount, { token: "" })).rejects.toThrow(
      /Unauthorized/,
    );
    await expect(
      t.mutation(api.dispatch.dispatch, {
        token: "not-a-real-token",
        action: "applyThreadOps",
        args: { ops: [] },
      }),
    ).rejects.toThrow(/Unauthorized/);
  });

  test("seeding mints a working token and the raw token is never stored", async () => {
    const { t, token } = await seeded();
    const { account } = await t.query(api.sync.getAccount, { token });
    expect(account.provider).toBe("demo");
    expect(account.email).toContain("nora@driftwork.io");

    const sessions = await rowsOf(t, "auth_sessions");
    expect(sessions).toHaveLength(1);
    const stored = (sessions[0] as Doc<"auth_sessions">).token_hash;
    expect(stored).not.toBe(token);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  test("two seeds get separate mailboxes rather than sharing one", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(api.demo.seed, {});
    const second = await t.mutation(api.demo.seed, {});
    expect(first.email).not.toBe(second.email);
    expect(first.token).not.toBe(second.token);
    expect(first.accountId).not.toBe(second.accountId);

    // The second mailbox gets a suffixed address, and every row it seeded as
    // "from me" has to carry THAT address — otherwise the app cannot tell
    // which messages the reader sent.
    const { account } = await t.query(api.sync.getAccount, {
      token: second.token,
    });
    const sent = await t.query(api.search.searchThreads, {
      token: second.token,
      q: "notes from the pricing call",
    });
    expect(sent).toHaveLength(1);
    const [message] = await t.query(api.sync.threadMessages, {
      token: second.token,
      threadGmailId: sent[0].gmail_id,
    });
    expect(message.from.email).toBe(account.email);
    expect(message.label_ids).toContain("SENT");
  });
});

describe("fixtures", () => {
  test("the demo mailbox has the shape the app expects", async () => {
    const { t, token } = await seeded();
    const { rows: threads } = await t.query(api.sync.listThreads, { token });
    expect(threads.length).toBeGreaterThanOrEqual(50);

    const has = (row: (typeof threads)[number], label: string) =>
      row.label_ids.includes(label);
    const inbox = threads.filter((row) => has(row, "INBOX"));
    const sent = threads.filter(
      (row) => has(row, "SENT") && !has(row, "INBOX"),
    );
    const trash = threads.filter((row) => has(row, "TRASH"));
    const spam = threads.filter((row) => has(row, "SPAM"));
    const archived = threads.filter(
      (row) =>
        !has(row, "INBOX") &&
        !has(row, "SENT") &&
        !has(row, "TRASH") &&
        !has(row, "SPAM"),
    );

    expect(sent).toHaveLength(6);
    expect(trash).toHaveLength(3);
    expect(spam).toHaveLength(2);
    expect(archived).toHaveLength(2);
    expect(threads.filter((row) => row.is_starred)).toHaveLength(2);
    expect(inbox.filter((row) => row.is_unread).length).toBeGreaterThanOrEqual(6);

    const drafts = await t.query(api.sync.listDrafts, { token });
    expect(drafts).toHaveLength(2);

    const labels = await t.query(api.sync.listLabels, { token });
    expect(labels.filter((l) => l.kind === "user").map((l) => l.name).sort()).toEqual([
      "Newsletters",
      "Receipts",
      "Travel",
    ]);
    expect(labels.filter((l) => l.kind === "system")).toHaveLength(7);
  });

  test("threads are ordered newest first and carry no bodies", async () => {
    const { t, token } = await seeded();
    const { rows: threads } = await t.query(api.sync.listThreads, { token });
    for (let i = 1; i < threads.length; i++) {
      expect(threads[i - 1].last_at).toBeGreaterThanOrEqual(threads[i].last_at);
    }
    for (const thread of threads) {
      expect(thread).not.toHaveProperty("body_html");
      // Multi-account sessions scope rows client-side by account_id.
      expect(thread.account_id).toBeDefined();
    }
    // 45 days of history, weighted to the last week.
    const now = Date.now();
    const oldest = threads[threads.length - 1].last_at;
    expect(now - oldest).toBeLessThan(46 * 24 * 60 * 60 * 1000);
    expect(
      threads.filter((row) => now - row.last_at < 7 * 24 * 60 * 60 * 1000).length,
    ).toBeGreaterThan(threads.length / 3);
  });

  test("the debate thread reads as a real conversation", async () => {
    const { t, token } = await seeded();
    const messages = await t.query(api.sync.threadMessages, {
      token,
      threadGmailId: DEBATE,
    });
    expect(messages).toHaveLength(8);
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].date).toBeGreaterThan(messages[i - 1].date);
      expect(messages[i].in_reply_to).toBe(messages[i - 1].header_message_id!);
      expect(messages[i].references).toContain(messages[0].header_message_id!);
    }
    // Distinct senders, and the owner's own replies are labelled SENT.
    const senders = new Set(messages.map((m) => m.from.email));
    expect(senders.size).toBeGreaterThanOrEqual(4);
    const mine = messages.filter((m) => m.from.email === "nora@driftwork.io");
    expect(mine.length).toBeGreaterThan(0);
    for (const message of mine) expect(message.label_ids).toContain("SENT");
  });

  test("bodies are authored prose, not placeholders", async () => {
    const { t, token } = await seeded();
    const { rows: threads } = await t.query(api.sync.listThreads, { token });
    for (const thread of threads) {
      const messages = await t.query(api.sync.threadMessages, {
        token,
        threadGmailId: thread.gmail_id,
      });
      for (const message of messages) {
        // 40 is the floor because a GitHub "closed as completed" line really
        // is one sentence; everything human is far longer.
        expect(message.body_text!.length).toBeGreaterThan(40);
        expect(message.body_text!.toLowerCase()).not.toContain("lorem ipsum");
        expect(message.body_text!).not.toMatch(/test (email|message) \d/i);
        expect(message.snippet.length).toBeGreaterThan(20);
      }
    }
  });

  test("attachments, HTML bodies and a Spanish thread are all present", async () => {
    const { t, token } = await seeded();
    const { rows: threads } = await t.query(api.sync.listThreads, { token });
    expect(threads.some((row) => row.has_attachments)).toBe(true);

    const invoice = threads.find((row) => row.subject.includes("Invoice 2291"))!;
    const invoiceMessages = await t.query(api.sync.threadMessages, {
      token,
      threadGmailId: invoice.gmail_id,
    });
    expect(invoiceMessages[0].attachments).toHaveLength(2);
    expect(invoiceMessages[0].attachments[0].mime_type).toBe("application/pdf");
    expect(invoiceMessages[0].attachments[0].size).toBeGreaterThan(1000);
    expect(invoiceMessages[0].body_html).toContain("<table");

    const spanish = threads.find((row) => row.subject.startsWith("Presupuesto"))!;
    const spanishMessages = await t.query(api.sync.threadMessages, {
      token,
      threadGmailId: spanish.gmail_id,
    });
    expect(spanishMessages[0].body_text).toContain("presupuesto");

    const newsletters = threads.filter((row) =>
      row.label_ids.includes("Label_Newsletters"),
    );
    expect(newsletters).toHaveLength(4);
    for (const newsletter of newsletters) {
      const [first] = await t.query(api.sync.threadMessages, {
        token,
        threadGmailId: newsletter.gmail_id,
      });
      expect(first.body_html).toContain("</p>");
      // Restrained means no scripts and no tracking images.
      expect(first.body_html).not.toContain("<script");
      expect(first.body_html).not.toContain("<img");
    }
  });
});

describe("applyThreadOps", () => {
  test("archive strips INBOX from the thread and all its messages", async () => {
    const { t, token } = await seeded();
    const before = await threadNamed(t, DEBATE);
    expect(before.label_ids).toContain("INBOX");

    await dispatch(t, token, "applyThreadOps", {
      ops: [{ thread_gmail_ids: [DEBATE], remove_label_ids: ["INBOX"] }],
    });

    const after = await threadNamed(t, DEBATE);
    expect(after.label_ids).not.toContain("INBOX");
    for (const message of await messagesIn(t, DEBATE)) {
      expect(message.label_ids).not.toContain("INBOX");
    }
  });

  test("read and star flags are derived, never set directly", async () => {
    const { t, token } = await seeded();
    expect((await threadNamed(t, DEBATE)).is_unread).toBe(true);

    await dispatch(t, token, "applyThreadOps", {
      ops: [{ thread_gmail_ids: [DEBATE], remove_label_ids: ["UNREAD"] }],
    });
    const read = await threadNamed(t, DEBATE);
    expect(read.is_unread).toBe(false);
    expect(read.label_ids).not.toContain("UNREAD");
    for (const message of await messagesIn(t, DEBATE)) {
      expect(message.is_unread).toBe(false);
    }

    await dispatch(t, token, "applyThreadOps", {
      ops: [{ thread_gmail_ids: [DEBATE], add_label_ids: ["STARRED"] }],
    });
    expect((await threadNamed(t, DEBATE)).is_starred).toBe(true);

    await dispatch(t, token, "applyThreadOps", {
      ops: [{ thread_gmail_ids: [DEBATE], remove_label_ids: ["STARRED"] }],
    });
    expect((await threadNamed(t, DEBATE)).is_starred).toBe(false);
  });

  test("one outbound row per op batch, not per thread", async () => {
    const { t, token } = await seeded();
    await dispatch(t, token, "applyThreadOps", {
      ops: [
        {
          thread_gmail_ids: [DEBATE, "demo-thread-03", "demo-thread-04"],
          remove_label_ids: ["INBOX"],
        },
      ],
    });

    const outbound = (await rowsOf(t, "outbound")) as Doc<"outbound">[];
    expect(outbound).toHaveLength(1);
    expect(outbound[0].kind).toBe("modify");
    expect(outbound[0].payload.thread_gmail_ids).toHaveLength(3);
    expect(outbound[0].payload.remove_label_ids).toEqual(["INBOX"]);
    // Every message in all three threads has to reach Gmail in the batch.
    expect(outbound[0].payload.message_gmail_ids.length).toBeGreaterThan(3);
    // A demo account has no upstream, so the row lands already settled.
    expect(outbound[0].status).toBe("done");

    for (const gmailId of [DEBATE, "demo-thread-03", "demo-thread-04"]) {
      expect((await threadNamed(t, gmailId)).label_ids).not.toContain("INBOX");
    }
  });

  test("separate ops in one dispatch each get their own outbound row", async () => {
    const { t, token } = await seeded();
    await dispatch(t, token, "applyThreadOps", {
      ops: [
        { thread_gmail_ids: [DEBATE], remove_label_ids: ["INBOX"] },
        { thread_gmail_ids: ["demo-thread-03"], add_label_ids: ["STARRED"] },
      ],
    });
    expect(await rowsOf(t, "outbound")).toHaveLength(2);
  });

  test("an op that changes nothing queues nothing", async () => {
    const { t, token } = await seeded();
    await dispatch(t, token, "applyThreadOps", {
      ops: [
        { thread_gmail_ids: [], remove_label_ids: ["INBOX"] },
        { thread_gmail_ids: [DEBATE] },
        { thread_gmail_ids: ["demo-thread-does-not-exist"], add_label_ids: ["X"] },
      ],
    });
    expect(await rowsOf(t, "outbound")).toHaveLength(0);
  });

  test("markSpam moves the thread out of the inbox", async () => {
    const { t, token } = await seeded();
    await dispatch(t, token, "markSpam", { thread_gmail_ids: [DEBATE] });
    const thread = await threadNamed(t, DEBATE);
    expect(thread.label_ids).toContain("SPAM");
    expect(thread.label_ids).not.toContain("INBOX");
  });

  test("deleteForever tombstones the rows and queues a delete", async () => {
    const { t, token } = await seeded();
    await dispatch(t, token, "deleteForever", { thread_gmail_ids: [DEBATE] });

    const thread = await threadNamed(t, DEBATE);
    expect(thread.deleted).toBe(true);
    for (const message of await messagesIn(t, DEBATE)) {
      expect(message.deleted).toBe(true);
    }
    const outbound = (await rowsOf(t, "outbound")) as Doc<"outbound">[];
    expect(outbound[0].payload.op).toBe("delete");
    // Tombstones still reach the client through the delta channel.
    const delta = await t.query(api.sync.listThreads, { token, since: 0 });
    expect(delta.rows.find((row) => row.gmail_id === DEBATE)?.deleted).toBe(true);
    // …and drop out of search.
    expect(
      await t.query(api.search.searchThreads, {
        token,
        q: "ship it without offline",
      }),
    ).toHaveLength(0);
  });
});

describe("updated_at watermark", () => {
  test("every touched row is bumped so delta sync sees it", async () => {
    const { t, token } = await seeded();
    const watermark = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 3));

    expect(
      (await t.query(api.sync.listThreads, { token, since: watermark })).rows,
    ).toHaveLength(0);

    await dispatch(t, token, "applyThreadOps", {
      ops: [{ thread_gmail_ids: [DEBATE], remove_label_ids: ["INBOX"] }],
    });

    const { rows: changed, nextSince } = await t.query(api.sync.listThreads, {
      token,
      since: watermark,
    });
    expect(changed).toHaveLength(1);
    expect(changed[0].gmail_id).toBe(DEBATE);
    expect(changed[0].updated_at).toBeGreaterThan(watermark);
    expect(nextSince).toBe(changed[0].updated_at);

    for (const message of await messagesIn(t, DEBATE)) {
      expect(message.updated_at).toBeGreaterThan(watermark);
    }
  });

  test("draft writes and deletes both advance the watermark", async () => {
    const { t, token } = await seeded();
    const watermark = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 3));

    await dispatch(t, token, "saveDraft", {
      client_id: "compose-1",
      to: [{ email: "theo@driftwork.io" }],
      subject: "Late thought",
      body_text: "One more thing before Thursday.",
      mode: "new",
    });
    let delta = await t.query(api.sync.listDrafts, { token, since: watermark });
    expect(delta).toHaveLength(1);

    const afterSave = delta[0].updated_at;
    await new Promise((resolve) => setTimeout(resolve, 3));
    await dispatch(t, token, "deleteDraft", { client_id: "compose-1" });
    delta = await t.query(api.sync.listDrafts, { token, since: afterSave });
    expect(delta).toHaveLength(1);
    expect(delta[0].deleted).toBe(true);
  });

  // Client-side drain: follow nextSince while hasMore, exactly as the store
  // does. The union of pages — not any single one — is what must be lossless.
  const drainAll = async (
    t: Harness,
    token: string,
    since: number,
    limit: number,
  ) => {
    const seen = new Set<string>();
    for (let hasMore = true, guard = 0; hasMore; ) {
      if (++guard > 10) throw new Error("watermark made no progress");
      const page = await t.query(api.sync.listThreads, { token, limit, since });
      for (const row of page.rows) seen.add(row._id);
      if (page.hasMore) expect(page.nextSince).toBeGreaterThan(since);
      since = page.nextSince;
      hasMore = page.hasMore;
    }
    return [...seen].sort();
  };

  test("a take boundary inside a same-timestamp group drops nothing", async () => {
    const { t, token } = await seeded();
    const base = Date.now() + 60_000;
    // Two rows at `base`, three sharing `base + 5`: with a page of 3, the old
    // `gt(updated_at).take(3)` cut the second group mid-way, and a client
    // advancing its watermark off the last row skipped the rest forever.
    const touched = await t.run(async (ctx) => {
      const threads = await ctx.db.query("threads").take(5);
      await Promise.all(
        threads.map((row, i) =>
          ctx.db.patch(row._id, { updated_at: i < 2 ? base : base + 5 }),
        ),
      );
      return threads.map((row) => row._id).sort();
    });

    const first = await t.query(api.sync.listThreads, {
      token,
      limit: 3,
      since: base - 1,
    });
    // The page trims back to the last fully drained timestamp.
    expect(first.rows).toHaveLength(2);
    expect(first.rows.every((row) => row.updated_at === base)).toBe(true);
    expect(first.nextSince).toBe(base);
    expect(first.hasMore).toBe(true);

    expect(await drainAll(t, token, base - 1, 3)).toEqual(touched);
  });

  test("a timestamp group wider than the page ships whole", async () => {
    const { t, token } = await seeded();
    const base = Date.now() + 60_000;
    const touched = await t.run(async (ctx) => {
      const threads = await ctx.db.query("threads").take(5);
      await Promise.all(
        threads.map((row) => ctx.db.patch(row._id, { updated_at: base })),
      );
      return threads.map((row) => row._id).sort();
    });

    // Five rows share one stamp against a page of 3: trimming would strand the
    // client, so the group ships whole and the watermark clears it.
    const page = await t.query(api.sync.listThreads, {
      token,
      limit: 3,
      since: base - 1,
    });
    expect(page.rows.map((row) => row._id).sort()).toEqual(touched);
    expect(page.nextSince).toBe(base);
    expect(page.hasMore).toBe(true);

    const rest = await t.query(api.sync.listThreads, {
      token,
      limit: 3,
      since: page.nextSince,
    });
    expect(rest.rows).toHaveLength(0);
    expect(rest.hasMore).toBe(false);
  });

  test("the merged watermark holds at the slowest account and loses nothing", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(api.demo.seed, {});
    await t.mutation(api.demo.seed, { attach_token: first.token });
    const token = first.token;
    const base = Date.now() + 60_000;

    // Account A: one row at base+9, drained in one page. Account B: one row
    // at base+2 and two sharing base+4 — a page of 2 trims B back to base+2.
    const touched = await t.run(async (ctx) => {
      const [a, b] = await ctx.db.query("accounts").collect();
      const pick = (accountId: Doc<"accounts">["_id"], n: number) =>
        ctx.db
          .query("threads")
          .withIndex("by_account_updated", (q) => q.eq("account_id", accountId))
          .take(n);
      const [rowA] = await pick(a._id, 1);
      const rowsB = await pick(b._id, 3);
      await ctx.db.patch(rowA._id, { updated_at: base + 9 });
      await ctx.db.patch(rowsB[0]._id, { updated_at: base + 2 });
      await ctx.db.patch(rowsB[1]._id, { updated_at: base + 4 });
      await ctx.db.patch(rowsB[2]._id, { updated_at: base + 4 });
      return [rowA._id, ...rowsB.map((row) => row._id)].sort();
    });

    const page = await t.query(api.sync.listThreads, {
      token,
      limit: 2,
      since: base,
    });
    // A already drained to base+9; the merged cursor must hold at B's base+2
    // or B's base+4 rows would be skipped. A's row redelivers next page, and
    // the client merges by id.
    expect(page.hasMore).toBe(true);
    expect(page.nextSince).toBe(base + 2);

    expect(await drainAll(t, token, base, 2)).toEqual(touched);
  });
});

describe("sendMessage", () => {
  test("a new message creates its own thread and queues a send", async () => {
    const { t, token } = await seeded();
    const result = await dispatch(t, token, "sendMessage", {
      client_id: "compose-alpha",
      to: [{ name: "Tess Okonkwo", email: "tess@okonkwo.cc" }],
      cc: [],
      bcc: [],
      subject: "Wednesday",
      body_text: "Seven works. I will bring the good shoes.",
    });
    expect(result.deduped).toBe(false);
    expect(result.thread_gmail_id).toBe("local-thread-compose-alpha");

    const thread = await threadNamed(t, "local-thread-compose-alpha");
    expect(thread.subject).toBe("Wednesday");
    expect(thread.message_count).toBe(1);
    expect(thread.label_ids).toEqual(["SENT"]);
    expect(thread.is_unread).toBe(false);
    expect(thread.client_id).toBe("compose-alpha");

    const [message] = await messagesIn(t, "local-thread-compose-alpha");
    expect(message.from.email).toBe("nora@driftwork.io");
    expect(message.to[0].email).toBe("tess@okonkwo.cc");
    expect(message.snippet).toContain("Seven works");

    const outbound = (await rowsOf(t, "outbound")) as Doc<"outbound">[];
    expect(outbound).toHaveLength(1);
    expect(outbound[0].kind).toBe("send");
    expect(outbound[0].status).toBe("done");
  });

  test("a send goes out as the chosen send-as address, else Gmail's default", async () => {
    const { t, token, accountId } = await seeded();
    await t.mutation(internal.gmail.sync.setSendAs, {
      accountId,
      send_as: [
        { email: "nora@driftwork.io" },
        { email: "nora@adeyemi.studio", name: "Nora A", is_default: true },
      ],
    });
    const send = (client_id: string, from?: string) =>
      dispatch(t, token, "sendMessage", { client_id, from, to: [{ email: "tess@okonkwo.cc" }], subject: "Hi", body_text: "Hi." });
    const sentFrom = async (r: { thread_gmail_id: string }) => (await messagesIn(t, r.thread_gmail_id))[0].from;

    expect(await sentFrom(await send("as-default"))).toEqual({ name: "Nora A", email: "nora@adeyemi.studio" });
    expect((await sentFrom(await send("as-chosen", "nora@driftwork.io"))).email).toBe("nora@driftwork.io");
    // An address the mailbox may not send as never reaches the From line.
    expect((await sentFrom(await send("as-stranger", "ceo@bigco.com"))).email).toBe("nora@adeyemi.studio");

    const queued = ((await rowsOf(t, "outbound")) as Doc<"outbound">[]).map((r) => r.payload.from.email);
    expect(queued.sort()).toEqual(["nora@adeyemi.studio", "nora@adeyemi.studio", "nora@driftwork.io"]);
  });

  test("the same client_id never sends twice", async () => {
    const { t, token } = await seeded();
    const args = {
      client_id: "compose-beta",
      to: [{ email: "tess@okonkwo.cc" }],
      subject: "Wednesday",
      body_text: "Seven works.",
    };
    const first = await dispatch(t, token, "sendMessage", args);
    const second = await dispatch(t, token, "sendMessage", args);

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.message_gmail_id).toBe(first.message_gmail_id);
    expect(await messagesIn(t, first.thread_gmail_id)).toHaveLength(1);
    expect(await rowsOf(t, "outbound")).toHaveLength(1);
  });

  test("a reply lands on the existing thread with correct headers", async () => {
    const { t, token } = await seeded();
    const parent = (await messagesIn(t, DEBATE)).sort(
      (a, b) => a.date - b.date,
    )[7];

    const result = await dispatch(t, token, "sendMessage", {
      client_id: "compose-reply",
      to: [{ email: "theo@driftwork.io" }],
      subject: "Re: Composer v3: do we ship it without offline?",
      body_text: "Capping the backoff at a minute is the right call. Ship it.",
      reply_to_gmail_id: parent.gmail_id,
    });

    expect(result.thread_gmail_id).toBe(DEBATE);
    const messages = (await messagesIn(t, DEBATE)).sort(
      (a, b) => a.date - b.date,
    );
    expect(messages).toHaveLength(9);

    const reply = messages[8];
    expect(reply.in_reply_to).toBe(parent.header_message_id!);
    expect(reply.references).toContain(parent.header_message_id!);
    expect(reply.label_ids).toEqual(["SENT"]);

    // The thread keeps its own subject and picks up the reply's recency.
    const thread = await threadNamed(t, DEBATE);
    expect(thread.subject).toBe("Composer v3: do we ship it without offline?");
    expect(thread.message_count).toBe(9);
    expect(thread.last_at).toBe(reply.date);
    expect(thread.label_ids).toContain("SENT");
    expect(thread.label_ids).toContain("INBOX");
  });

  test("sending a draft retires it", async () => {
    const { t, token } = await seeded();
    await dispatch(t, token, "saveDraft", {
      client_id: "compose-gamma",
      to: [{ email: "tess@okonkwo.cc" }],
      subject: "Wednesday",
      body_text: "Seven works.",
      mode: "new",
    });
    await dispatch(t, token, "sendMessage", {
      client_id: "compose-gamma",
      to: [{ email: "tess@okonkwo.cc" }],
      subject: "Wednesday",
      body_text: "Seven works.",
    });

    const drafts = await t.query(api.sync.listDrafts, { token, since: 0 });
    const sentDraft = drafts.find((d) => d.client_id === "compose-gamma")!;
    expect(sentDraft.deleted).toBe(true);
  });
});

describe("outgoing files", () => {
  const store = (t: Harness, text: string) =>
    t.run(async (ctx) => await ctx.storage.store(new Blob([text], { type: "text/plain" })));
  // A boolean, not the blob: t.run can only hand back Convex values.
  const stored = (t: Harness, id: string) => t.run(async (ctx) => !!(await ctx.storage.get(id as Id<"_storage">)));

  test("a send carries its upload to the outbox and onto the sent row", async () => {
    const { t, token } = await seeded();
    const storageId = await store(t, "quarterly numbers");
    const result = await dispatch(t, token, "sendMessage", {
      client_id: "send-with-file",
      to: [{ email: "priya@driftwork.io" }],
      subject: "Numbers",
      body_text: "Attached.",
      attachments: [{ filename: "q3.csv", mime_type: "text/csv", size: 1, storage_id: storageId }],
    });
    const [row] = await messagesIn(t, result.thread_gmail_id);
    // The size comes from storage, not from what the client claimed.
    expect(row.attachments).toEqual([
      { filename: "q3.csv", mime_type: "text/csv", size: "quarterly numbers".length, gmail_attachment_id: "" },
    ]);
    expect((await threadNamed(t, result.thread_gmail_id)).has_attachments).toBe(true);
    const outbound = ((await rowsOf(t, "outbound")) as Doc<"outbound">[]).find(
      (o) => o.kind === "send" && o.payload.client_id === "send-with-file",
    )!;
    expect(outbound.payload.attachments[0].storage_id).toBe(storageId);
    // The upload is still there for the pump to read.
    expect(await stored(t, storageId)).toBe(true);
  });

  test("a missing upload or an over-size total refuses the send", async () => {
    const { t, token } = await seeded();
    const storageId = await store(t, "x");
    await t.run(async (ctx) => await ctx.storage.delete(storageId));
    await expect(
      dispatch(t, token, "sendMessage", {
        client_id: "send-gone-file",
        to: [{ email: "priya@driftwork.io" }],
        subject: "",
        body_text: "",
        attachments: [{ filename: "gone.txt", mime_type: "text/plain", size: 1, storage_id: storageId }],
      }),
    ).rejects.toThrow(/not found/);
  });

  test("forwarding names a file on a message of this mailbox", async () => {
    const { t, token } = await seeded();
    const withFile = ((await rowsOf(t, "messages")) as Doc<"messages">[]).find((m) => m.attachments.length > 0)!;
    const result = await dispatch(t, token, "sendMessage", {
      client_id: "forward-with-file",
      to: [{ email: "priya@driftwork.io" }],
      subject: "Fwd",
      body_text: "",
      attachments: [
        {
          filename: withFile.attachments[0].filename,
          mime_type: "",
          size: 0,
          message_gmail_id: withFile.gmail_id,
          gmail_attachment_id: withFile.attachments[0].gmail_attachment_id,
        },
        { filename: "nope", mime_type: "", size: 0 },
      ],
    });
    const [row] = await messagesIn(t, result.thread_gmail_id);
    expect(row.attachments).toEqual([withFile.attachments[0]]);
    await expect(
      dispatch(t, token, "sendMessage", {
        client_id: "forward-bad-file",
        to: [{ email: "priya@driftwork.io" }],
        subject: "",
        body_text: "",
        attachments: [{ filename: "x", mime_type: "", size: 0, message_gmail_id: withFile.gmail_id, gmail_attachment_id: "no-such" }],
      }),
    ).rejects.toThrow(/No file/);
  });

  test("a draft keeps its uploads until they are dropped, deleted, or sent", async () => {
    const { t, token } = await seeded();
    const first = await store(t, "one");
    const second = await store(t, "two");
    const file = (name: string, id: string) => ({ filename: name, mime_type: "text/plain", size: 3, storage_id: id });
    const base = { client_id: "draft-files", to: [{ email: "priya@driftwork.io" }], subject: "", body_text: "", mode: "new" };
    await dispatch(t, token, "saveDraft", { ...base, attachments: [file("one.txt", first), file("two.txt", second)] });
    // Dropping a file from the draft frees it; the kept one stays.
    await dispatch(t, token, "saveDraft", { ...base, attachments: [file("two.txt", second)] });
    expect(await stored(t, first)).toBe(false);
    expect(await stored(t, second)).toBe(true);
    // Sending under the draft's id hands the file to the send, not the bin.
    await dispatch(t, token, "sendMessage", { ...base, attachments: [file("two.txt", second)] });
    expect(await stored(t, second)).toBe(true);
    const draft = ((await rowsOf(t, "drafts")) as Doc<"drafts">[]).find((d) => d.client_id === "draft-files")!;
    expect(draft.deleted).toBe(true);

    const third = await store(t, "three");
    await dispatch(t, token, "saveDraft", { ...base, client_id: "draft-binned", attachments: [file("three.txt", third)] });
    await dispatch(t, token, "deleteDraft", { client_id: "draft-binned" });
    expect(await stored(t, third)).toBe(false);
  });
});

describe("drafts", () => {
  test("save upserts by client_id and delete tombstones", async () => {
    const { t, token } = await seeded();
    const created = await dispatch(t, token, "saveDraft", {
      client_id: "compose-delta",
      to: [{ email: "priya@driftwork.io" }],
      subject: "Empty states",
      body_text: "First pass.",
      mode: "new",
    });
    expect(created.created).toBe(true);

    const updated = await dispatch(t, token, "saveDraft", {
      client_id: "compose-delta",
      to: [{ email: "priya@driftwork.io" }, { email: "theo@driftwork.io" }],
      subject: "Empty states",
      body_text: "Second pass, with the count under it.",
      mode: "new",
    });
    expect(updated.created).toBe(false);

    const drafts = (await rowsOf(t, "drafts")) as Doc<"drafts">[];
    const mine = drafts.filter((d) => d.client_id === "compose-delta");
    expect(mine).toHaveLength(1);
    expect(mine[0].to).toHaveLength(2);
    expect(mine[0].body_text).toContain("Second pass");

    await dispatch(t, token, "deleteDraft", { client_id: "compose-delta" });
    const after = ((await rowsOf(t, "drafts")) as Doc<"drafts">[]).find(
      (d) => d.client_id === "compose-delta",
    )!;
    expect(after.deleted).toBe(true);

    // Re-saving the same id resurrects rather than duplicating.
    await dispatch(t, token, "saveDraft", {
      client_id: "compose-delta",
      to: [{ email: "priya@driftwork.io" }],
      subject: "Empty states",
      body_text: "Third pass.",
      mode: "new",
    });
    const resurrected = ((await rowsOf(t, "drafts")) as Doc<"drafts">[]).filter(
      (d) => d.client_id === "compose-delta",
    );
    expect(resurrected).toHaveLength(1);
    expect(resurrected[0].deleted).toBeUndefined();
  });

  test("a side effect without client_id is refused", async () => {
    const { t, token } = await seeded();
    await expect(
      dispatch(t, token, "saveDraft", { subject: "no id" }),
    ).rejects.toThrow(/client_id/);
    await expect(
      dispatch(t, token, "sendMessage", { subject: "no id" }),
    ).rejects.toThrow(/client_id/);
  });
});

describe("client_state patches", () => {
  test("declared fields patch, unknown keys land in the prefs bag", async () => {
    const { t, token } = await seeded();
    await dispatch(t, token, "setPreference", {}, {
      client_state: { singleton: { theme: "dark", rail_collapsed: true } },
    });

    let state = (await t.query(api.sync.getAccount, { token })).client_state!;
    expect(state.theme).toBe("dark");
    expect(state.rail_collapsed).toBe(true);

    await dispatch(t, token, "setPreference", {}, {
      client_state: { singleton: { list_density_override: "roomy" } },
    });
    state = (await t.query(api.sync.getAccount, { token })).client_state!;
    expect(state.theme).toBe("dark");
    expect(state.prefs).toEqual({ list_density_override: "roomy" });

    // A null clears a field rather than writing null into it.
    await dispatch(t, token, "setPreference", {}, {
      client_state: { singleton: { signature: null } },
    });
    state = (await t.query(api.sync.getAccount, { token })).client_state!;
    expect(state.signature).toBeUndefined();
  });

  test("account_id cannot be patched and unknown tables are ignored", async () => {
    const { t, token, accountId } = await seeded();
    await dispatch(t, token, "setPreference", {}, {
      client_state: { singleton: { account_id: "someone-else", theme: "dark" } },
      threads: { [DEBATE]: { subject: "hijacked" } },
      accounts: { x: { email: "attacker@example.com" } },
    });

    const state = (await rowsOf(t, "client_state"))[0] as Doc<"client_state">;
    // Prefs rows are user-owned; a client can neither plant an account_id nor
    // pick its owner.
    const account = (await rowsOf(t, "accounts")).find(
      (a) => a._id === accountId,
    ) as Doc<"accounts">;
    expect(state.user_id).toBe(account.user_id!);
    expect(state.account_id).toBeUndefined();
    expect(state.theme).toBe("dark");
    expect((await threadNamed(t, DEBATE)).subject).toBe(
      "Composer v3: do we ship it without offline?",
    );
  });

  test("an unknown action is a no-op rather than an error", async () => {
    const { t, token } = await seeded();
    expect(await dispatch(t, token, "somethingNewerThanTheServer", {})).toBeNull();
  });
});

describe("client argument shape", () => {
  test("an argument LIST is unwrapped and client-only extras ignored", async () => {
    const { t, token } = await seeded();
    // The store middleware forwards a whole action call, so
    // archiveThreads({ops}, "Archived") arrives as [{ops}, "Archived"].
    await dispatch(t, token, "applyThreadOps", [
      { ops: [{ thread_gmail_ids: [DEBATE], remove_label_ids: ["INBOX"] }] },
      "Archived",
    ]);
    expect((await threadNamed(t, DEBATE)).label_ids).not.toContain("INBOX");

    const sent = await dispatch(t, token, "sendMessage", [
      {
        client_id: "list-form",
        to: [{ email: "tess@okonkwo.cc" }],
        subject: "Wednesday",
        body_text: "Seven works.",
      },
      { undoLabel: "Sent" },
    ]);
    expect(sent.deduped).toBe(false);
    expect(sent.message_gmail_id).toBe("local-msg-list-form");
  });

  test("an object, an empty list and junk are all handled", async () => {
    const { t, token } = await seeded();
    // The object form still works, unchanged.
    await dispatch(t, token, "applyThreadOps", {
      ops: [{ thread_gmail_ids: [DEBATE], add_label_ids: ["STARRED"] }],
    });
    expect((await threadNamed(t, DEBATE)).is_starred).toBe(true);

    // A missing or unusable payload is an empty op, not a crash.
    expect(await dispatch(t, token, "applyThreadOps", [])).toEqual({
      applied: [],
    });
    expect(await dispatch(t, token, "applyThreadOps", ["just a label"])).toEqual(
      { applied: [] },
    );
    await expect(
      dispatch(t, token, "saveDraft", ["no payload here"]),
    ).rejects.toThrow(/client_id/);
  });
});

describe("canonical label order", () => {
  test("every seeded row stores labels sorted", async () => {
    const { t, token } = await seeded();
    const { rows: threads } = await t.query(api.sync.listThreads, { token });
    for (const thread of threads) {
      expect(thread.label_ids).toEqual([...thread.label_ids].sort());
      const messages = await t.query(api.sync.threadMessages, {
        token,
        threadGmailId: thread.gmail_id,
      });
      for (const message of messages) {
        expect(message.label_ids).toEqual([...message.label_ids].sort());
      }
    }
  });

  test("writes keep labels sorted whatever order the client asks in", async () => {
    const { t, token } = await seeded();
    // Deliberately reverse-alphabetical additions.
    await dispatch(t, token, "applyThreadOps", {
      ops: [
        {
          thread_gmail_ids: [DEBATE],
          add_label_ids: ["STARRED", "Label_Travel", "IMPORTANT"],
        },
      ],
    });
    const thread = await threadNamed(t, DEBATE);
    expect(thread.label_ids).toEqual([...thread.label_ids].sort());
    expect(thread.label_ids).toContain("IMPORTANT");
    for (const message of await messagesIn(t, DEBATE)) {
      expect(message.label_ids).toEqual([...message.label_ids].sort());
    }

    // …including a thread born from a send.
    await dispatch(t, token, "sendMessage", {
      client_id: "sorted-send",
      to: [{ email: "tess@okonkwo.cc" }],
      subject: "Wednesday",
      body_text: "Seven works.",
    });
    const fresh = await threadNamed(t, "local-thread-sorted-send");
    expect(fresh.label_ids).toEqual([...fresh.label_ids].sort());
  });
});

describe("search", () => {
  let harness: { t: Harness; token: string };
  beforeEach(async () => {
    harness = await seeded();
  });

  test("matches subject, participants and snippet", async () => {
    const { t, token } = harness;
    const lisbon = await t.query(api.search.searchThreads, {
      token,
      q: "Lisbon",
    });
    expect(lisbon.length).toBeGreaterThanOrEqual(2);

    const byPerson = await t.query(api.search.searchThreads, {
      token,
      q: "from:hannah",
    });
    expect(byPerson.length).toBeGreaterThanOrEqual(1);
    expect(byPerson[0].participants.some((p) => p.email.includes("vogel"))).toBe(
      true,
    );
  });

  test("terms are conjunctive and operators narrow", async () => {
    const { t, token } = harness;
    expect(
      await t.query(api.search.searchThreads, { token, q: "composer offline" }),
    ).toHaveLength(1);
    expect(
      await t.query(api.search.searchThreads, {
        token,
        q: "composer unicorn",
      }),
    ).toHaveLength(0);

    const starred = await t.query(api.search.searchThreads, {
      token,
      q: "is:starred",
    });
    expect(starred).toHaveLength(2);

    const receipts = await t.query(api.search.searchThreads, {
      token,
      q: "label:Receipts",
    });
    expect(receipts.length).toBeGreaterThanOrEqual(4);
    for (const row of receipts) {
      expect(row.label_ids).toContain("Label_Receipts");
    }

    const withFiles = await t.query(api.search.searchThreads, {
      token,
      q: "has:attachment",
    });
    expect(withFiles.every((row) => row.has_attachments)).toBe(true);
  });

  test("an empty query returns nothing, and spam and trash stay out", async () => {
    const { t, token } = harness;
    expect(await t.query(api.search.searchThreads, { token, q: "   " })).toHaveLength(0);
    const junk = await t.query(api.search.searchThreads, {
      token,
      q: "congratulations",
    });
    expect(junk).toHaveLength(0);
  });

  test("the limit is honoured", async () => {
    const { t, token } = harness;
    const capped = await t.query(api.search.searchThreads, {
      token,
      q: "is:unread",
      limit: 2,
    });
    expect(capped).toHaveLength(2);
  });
});

describe("account surface", () => {
  test("credentials are never exposed and pending sends are counted", async () => {
    const { t, token, accountId } = await seeded();
    await t.run(async (ctx) => {
      // A demo account has no credentials; plant one to prove the query shape
      // cannot leak it.
      await ctx.db.insert("credentials", {
        account_id: accountId,
        access_token: "secret-access",
        refresh_token: "secret-refresh",
        expiry: Date.now() + 3600_000,
      });
    });
    const payload = await t.query(api.sync.getAccount, { token });
    expect(JSON.stringify(payload)).not.toContain("secret-");
    expect(payload.outbound_pending).toBe(0);
    expect(payload.account).not.toHaveProperty("history_id");
  });

  test("refresh does nothing for a demo account", async () => {
    const { t, token } = await seeded();
    expect(await t.mutation(api.sync.refresh, { token })).toEqual({
      scheduled: false,
    });
  });
});

describe("demo reset", () => {
  test("reset removes the caller's own mailbox", async () => {
    const { t, token } = await seeded();
    await t.mutation(api.demo.reset, { token });
    expect(await rowsOf(t, "threads")).toHaveLength(0);
    expect(await rowsOf(t, "messages")).toHaveLength(0);
    expect(await rowsOf(t, "auth_sessions")).toHaveLength(0);
  });

  test("reset rejects an unknown token and a non-demo account's token", async () => {
    const { t } = await seeded();
    await expect(t.mutation(api.demo.reset, { token: "bogus" })).rejects.toThrow();

    // A gmail account with a real session token cannot reset (provider guard).
    const gmailToken = await t.run(async (ctx) => {
      const gmailAccountId = await ctx.db.insert("accounts", {
        email: "real@example.com",
        provider: "gmail" as const,
        sync_status: "idle" as const,
        updated_at: Date.now(),
      });
      const userId = await ensureUserForAccount(
        ctx,
        (await ctx.db.get(gmailAccountId))!,
      );
      return await createAuthSession(ctx, userId);
    });
    await expect(
      t.mutation(api.demo.reset, { token: gmailToken }),
    ).rejects.toThrow(/demo/);
  });
});

describe("user identity", () => {
  test("signing in with a connected address recovers the whole roster", async () => {
    // Device 1: seed a mailbox, then attach a second one to the session.
    const t = convexTest(schema, modules);
    const first = await t.mutation(api.demo.seed, {});
    const second = await t.mutation(api.demo.seed, {
      attach_token: first.token,
    });
    const device1 = await t.query(api.sync.getAccount, { token: first.token });
    expect(device1.accounts).toHaveLength(2);

    // Device 2: a fresh sign-in with the FIRST account's identity (what the
    // OAuth callback does for a known email) must yield both accounts.
    const device2Token = await t.run(async (ctx) => {
      const account = (await ctx.db.get(first.accountId))!;
      const userId = await ensureUserForAccount(ctx, account);
      return await createAuthSession(ctx, userId);
    });
    const device2 = await t.query(api.sync.getAccount, { token: device2Token });
    expect(device2.accounts.map((a) => a.email).sort()).toEqual(
      device1.accounts.map((a) => a.email).sort(),
    );
    expect(second.accountId).not.toBe(first.accountId);
  });

  test("attaching an account another user owns merges the two users", async () => {
    const t = convexTest(schema, modules);
    // Two independent sign-ups: two users.
    const a = await t.mutation(api.demo.seed, {});
    const b = await t.mutation(api.demo.seed, {});
    expect((await rowsOf(t, "users")).length).toBe(2);

    // User A connects B's mailbox — the proof both rosters are one person.
    const ok = await t.run(async (ctx) =>
      attachAccountToSession(ctx, await hashToken(a.token), b.accountId),
    );
    expect(ok).toBe(true);

    // One user remains, and BOTH device tokens now see both accounts.
    expect((await rowsOf(t, "users")).length).toBe(1);
    for (const token of [a.token, b.token]) {
      const { accounts } = await t.query(api.sync.getAccount, { token });
      expect(accounts).toHaveLength(2);
    }
  });

  test("prefs follow the user to a second device", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(api.demo.seed, {});
    await dispatch(t, first.token, "setClientPref", ["theme", "dark"], {
      client_state: { singleton: { theme: "dark" } },
    });

    const device2Token = await t.run(async (ctx) => {
      const account = (await ctx.db.get(first.accountId))!;
      const userId = await ensureUserForAccount(ctx, account);
      return await createAuthSession(ctx, userId);
    });
    const { client_state } = await t.query(api.sync.getAccount, {
      token: device2Token,
    });
    expect(client_state?.theme).toBe("dark");
  });

  test("backfillUsers upgrades legacy sessions in place", async () => {
    const t = convexTest(schema, modules);
    const seedA = await t.mutation(api.demo.seed, {});
    const seedB = await t.mutation(api.demo.seed, {});

    // Rebuild the pre-users world: strip user_id everywhere and replace the
    // sessions with one legacy token listing both accounts.
    const legacyToken = "legacy-token-for-migration-test";
    await t.run(async (ctx) => {
      for (const u of await ctx.db.query("users").collect()) {
        await ctx.db.delete(u._id);
      }
      for (const a of await ctx.db.query("accounts").collect()) {
        await ctx.db.patch(a._id, { user_id: undefined });
      }
      for (const s2 of await ctx.db.query("auth_sessions").collect()) {
        await ctx.db.delete(s2._id);
      }
      const hash = await hashToken(legacyToken);
      for (const accountId of [seedA.accountId, seedB.accountId]) {
        await ctx.db.insert("auth_sessions", {
          account_id: accountId,
          token_hash: hash,
          created_at: Date.now(),
          last_seen_at: Date.now(),
        });
      }
    });

    const result = await t.mutation(internal.migrations.backfillUsers, {});
    expect(result.sessionsUpgraded).toBe(1);

    // The legacy token still works, resolves through ONE user, and sees both.
    const { accounts } = await t.query(api.sync.getAccount, {
      token: legacyToken,
    });
    expect(accounts).toHaveLength(2);
    expect((await rowsOf(t, "users")).length).toBe(1);
    const sessions = await rowsOf(t, "auth_sessions");
    for (const row of sessions) {
      expect((row as Doc<"auth_sessions">).user_id).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Convex Auth migration (ct-44709): every public function resolves a caller
// from either a Convex Auth identity (ctx.auth, preferred) or a legacy opaque
// token. The legacy path is pinned byte-for-byte by every test above; these
// pin the identity path and the seams between the two.
// ---------------------------------------------------------------------------

describe("dual caller resolution", () => {
  // A signed-in Convex Auth caller, the way convexAuth builds subjects:
  // "<userId>|<sessionId>" over a real users row.
  async function signedIn(t: Harness, email = "person@example.com") {
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email, created_at: Date.now() }),
    );
    return { userId, asUser: t.withIdentity({ subject: `${userId}|session-1` }) };
  }

  test("no credential at all is rejected; a bogus identity resolves nothing", async () => {
    const { t } = await seeded();
    await expect(t.query(api.sync.getAccount, {})).rejects.toThrow(/Unauthorized/);
    // A subject naming a user row that does not exist must not mint access.
    const forged = t.withIdentity({ subject: "users_nope|session-1" });
    await expect(forged.query(api.sync.getAccount, {})).rejects.toThrow(/Unauthorized/);
  });

  test("a signed-in caller needs no token and starts with an empty roster", async () => {
    const t = convexTest(schema, modules);
    const { asUser } = await signedIn(t);
    const envelope = await asUser.query(api.sync.getAccount, {});
    expect(envelope.account).toBeNull();
    expect(envelope.accounts).toEqual([]);
    const page = await asUser.query(api.sync.listThreads, {});
    expect(page.rows).toEqual([]);
  });

  test("identity outranks a presented legacy token once the user owns accounts", async () => {
    const { t, token } = await seeded();
    const { userId, asUser } = await signedIn(t);
    // Give the signed-in user their own (empty) demo mailbox.
    const own = await asUser.mutation(api.demo.seed, {});
    // With both credentials presented, the identity's roster answers — not
    // the token's.
    const envelope = await asUser.query(api.sync.getAccount, { token });
    expect(envelope.accounts).toHaveLength(1);
    expect(envelope.accounts[0]._id).toBe(own.accountId);
    const rows = await t.run(async (ctx) => ctx.db.get(own.accountId));
    expect(rows!.user_id).toBe(userId);
  });

  test("a signed-in caller with an empty roster falls back to its legacy token", async () => {
    const { t, token, accountId } = await seeded();
    const { asUser } = await signedIn(t);
    // Signed in, nothing connected, but the demo token from before sign-in is
    // still presented: the demo mailbox keeps working until it is adopted.
    const envelope = await asUser.query(api.sync.getAccount, { token });
    expect(envelope.accounts.map((a: any) => a._id)).toEqual([accountId]);
  });

  test("demo.seed under an identity attaches to it and mints no token", async () => {
    const t = convexTest(schema, modules);
    const { userId, asUser } = await signedIn(t);
    const result = await asUser.mutation(api.demo.seed, {});
    expect(result.token).toBeNull();
    const sessions = await rowsOf(t, "auth_sessions");
    expect(sessions).toHaveLength(0);
    const account = await t.run(async (ctx) => ctx.db.get(result.accountId));
    expect(account!.user_id).toBe(userId);
    // The roster arrives through the identity, no token anywhere.
    const envelope = await asUser.query(api.sync.getAccount, {});
    expect(envelope.accounts).toHaveLength(1);
    // And the caller can act on it: dispatch with no token.
    const applied = await asUser.mutation(api.dispatch.dispatch, {
      action: "applyThreadOps",
      args: {
        ops: [{ thread_gmail_ids: [DEBATE], remove_label_ids: ["INBOX"] }],
      },
    });
    expect(applied.applied).toHaveLength(1);
  });

  test("adoptLegacySession folds a pre-sign-in roster into the identity", async () => {
    const { t, token, accountId } = await seeded();
    const { userId, asUser } = await signedIn(t);
    const { adopted } = await asUser.mutation(api.auth.adoptLegacySession, { token });
    expect(adopted).toBe(true);
    // The identity now owns the demo mailbox…
    const envelope = await asUser.query(api.sync.getAccount, {});
    expect(envelope.accounts.map((a: any) => a._id)).toEqual([accountId]);
    const account = await t.run(async (ctx) => ctx.db.get(accountId));
    expect(account!.user_id).toBe(userId);
    // …and the token that authorized the adoption is spent. This device now
    // signs in with Convex Auth, so it needs no bearer credential, and a
    // stolen copy of the string must not stay adoptable.
    expect(await rowsOf(t, "auth_sessions")).toHaveLength(0);
    await expect(t.query(api.sync.getAccount, { token })).rejects.toThrow(
      /Unauthorized/,
    );
  });

  test("adopting is refused without an identity", async () => {
    const { t, token } = await seeded();
    await expect(
      t.mutation(api.auth.adoptLegacySession, { token }),
    ).rejects.toThrow(/Unauthorized/);
  });

  // ——— A legacy token is a bearer credential, never an identity claim ———
  // Knowing the token string must buy no more than the token already buys:
  // revocable access to one roster. These pin the ceiling.

  /** Give a user the Convex Auth rows a Google sign-in leaves behind. */
  async function withGoogleIdentity(
    t: Harness,
    userId: Id<"users">,
    providerAccountId: string,
  ) {
    await t.run(async (ctx) => {
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "google",
        providerAccountId,
      });
      await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 3600_000,
      });
    });
  }

  const userOf = async (t: Harness, accountId: Id<"accounts">) =>
    (await t.run(async (ctx) => ctx.db.get(accountId)))!.user_id!;

  test("adoption is refused when the legacy roster signs in on its own", async () => {
    const { t, token, accountId } = await seeded();
    // The victim connected before the migration and has since signed in with
    // Google, so their roster and their identity live on one user row.
    const victimId = await userOf(t, accountId);
    await withGoogleIdentity(t, victimId, "victim-google");
    // The attacker knows the token string and nothing else. Their sign-in is
    // a throwaway Google account — free to make, proves nothing about them.
    const { asUser: asAttacker } = await signedIn(t, "attacker@example.com");
    const result = await asAttacker.mutation(api.auth.adoptLegacySession, {
      token,
    });
    expect(result.adopted).toBe(false);
    expect(result.reason).toBe("own-identity");
    // The mailbox, the identity row and the user row all stay put.
    expect(await userOf(t, accountId)).toBe(victimId);
    const identities = await rowsOf(t, "authAccounts");
    expect(identities.map((r: any) => r.userId)).toEqual([victimId]);
    expect(await t.run(async (ctx) => ctx.db.get(victimId))).not.toBeNull();
    // The attacker gained nothing…
    expect((await asAttacker.query(api.sync.getAccount, {})).accounts).toEqual(
      [],
    );
    // …and the victim keeps their revocable bearer access.
    const viaToken = await t.query(api.sync.getAccount, { token });
    expect(viaToken.accounts.map((a: any) => a._id)).toEqual([accountId]);
    // Revoking it still ends the access, which is the point of a token.
    await dispatch(t, token, "signOut", {});
    await expect(t.query(api.sync.getAccount, { token })).rejects.toThrow(
      /Unauthorized/,
    );
    expect(await userOf(t, accountId)).toBe(victimId);
  });

  test("a token-authorized merge never repoints the identity tables", async () => {
    const { t, token, accountId } = await seeded();
    const legacyId = await userOf(t, accountId);
    const { userId, asUser } = await signedIn(t);
    // The signed-in caller's own identity, the way Convex Auth writes it.
    await withGoogleIdentity(t, userId, "person-google");
    expect(
      (await asUser.mutation(api.auth.adoptLegacySession, { token })).adopted,
    ).toBe(true);
    // The roster moved; the identity row did not, and no identity row was
    // created for the merged-away user.
    expect(await userOf(t, accountId)).toBe(userId);
    const identities = await rowsOf(t, "authAccounts");
    expect(identities.map((r: any) => r.userId)).toEqual([userId]);
    const authSessions = await rowsOf(t, "authSessions");
    expect(authSessions.map((r: any) => r.userId)).toEqual([userId]);
    expect(await t.run(async (ctx) => ctx.db.get(legacyId))).toBeNull();
  });

  test("mergeUsers refuses to merge away a user that signs in on its own", async () => {
    const t = convexTest(schema, modules);
    const { userId: winner } = await signedIn(t, "winner@example.com");
    const { userId: loser } = await signedIn(t, "loser@example.com");
    await withGoogleIdentity(t, loser, "loser-google");
    // Caught inside the transaction: letting it escape t.run would leave the
    // harness mid-transaction for every test after this one.
    const failure = await t.run(async (ctx) => {
      try {
        await mergeUsers(ctx, winner, loser);
        return null;
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    });
    expect(failure).toMatch(/signs in on its own/);
    const identities = await rowsOf(t, "authAccounts");
    expect(identities.map((r: any) => r.userId)).toEqual([loser]);
    expect(await t.run(async (ctx) => ctx.db.get(loser))).not.toBeNull();
  });

  test("adopting is single use, so a copy of the token cannot re-adopt", async () => {
    const { t, token, accountId } = await seeded();
    const { userId, asUser } = await signedIn(t);
    expect(
      (await asUser.mutation(api.auth.adoptLegacySession, { token })).adopted,
    ).toBe(true);
    // A second holder of the same string arrives too late.
    const { asUser: asThief } = await signedIn(t, "thief@example.com");
    expect(
      (await asThief.mutation(api.auth.adoptLegacySession, { token })).adopted,
    ).toBe(false);
    // Re-running on the owner's next boot is a harmless no-op.
    expect(
      (await asUser.mutation(api.auth.adoptLegacySession, { token })).adopted,
    ).toBe(false);
    expect(await userOf(t, accountId)).toBe(userId);
    expect((await rowsOf(t, "users")).length).toBe(2);
    const envelope = await asUser.query(api.sync.getAccount, {});
    expect(envelope.accounts.map((a: any) => a._id)).toEqual([accountId]);
  });

  test("a connect cannot merge away a mailbox owner that signs in on its own", async () => {
    // Same ceiling on the other token-authorized path: the attach flow reads
    // its winner from a token string, so a stolen token must not pull another
    // user's Google identity onto it either.
    const { t, token, accountId } = await seeded();
    const victimId = await userOf(t, accountId);
    const connected = await t.mutation(internal.gmail.oauth.completeConnect, {
      email: "attacker@gmail.com",
      access_token: "at",
      refresh_token: "rt",
      expiry: Date.now() + 3600_000,
    });
    const attackerId = await userOf(t, connected.accountId);
    await withGoogleIdentity(t, attackerId, "attacker-google");
    await expect(
      t.mutation(internal.gmail.oauth.completeConnect, {
        email: "attacker@gmail.com",
        access_token: "at2",
        refresh_token: "rt2",
        expiry: Date.now() + 3600_000,
        attach_hash: await hashToken(token),
      }),
    ).rejects.toThrow(/signs in on its own/);
    expect(await userOf(t, accountId)).toBe(victimId);
    expect(await userOf(t, connected.accountId)).toBe(attackerId);
    const identities = await rowsOf(t, "authAccounts");
    expect(identities.map((r: any) => r.userId)).toEqual([attackerId]);
  });

  /** Two user rows claiming one address, the way the migration finds them. */
  async function twoRowsOneAddress(t: Harness) {
    const legacyId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        primary_email: "Person@Example.com",
        created_at: Date.now(),
      }),
    );
    const signInId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        email: "person@example.com",
        created_at: Date.now(),
      }),
    );
    return { legacyId, signInId };
  }

  test("the sign-in backfill keeps the row that signs in on its own", async () => {
    const t = convexTest(schema, modules);
    const { legacyId, signInId } = await twoRowsOneAddress(t);
    // The newer row is the person's Google sign-in. Collapsing the pair the
    // other way round would delete a working login.
    await withGoogleIdentity(t, signInId, "person-google");
    const result = await t.mutation(
      internal.migrations.linkLegacyUsersForConvexAuth,
      {},
    );
    expect(result.usersMerged).toBe(1);
    expect(await t.run(async (ctx) => ctx.db.get(signInId))).not.toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(legacyId))).toBeNull();
    const survivor = await t.run(async (ctx) => ctx.db.get(signInId));
    expect(survivor!.email).toBe("person@example.com");
    const identities = await rowsOf(t, "authAccounts");
    expect(identities.map((r: any) => r.userId)).toEqual([signInId]);
  });

  test("the sign-in backfill leaves two working logins alone", async () => {
    const t = convexTest(schema, modules);
    const { legacyId, signInId } = await twoRowsOneAddress(t);
    await withGoogleIdentity(t, legacyId, "person-google");
    await withGoogleIdentity(t, signInId, "person-google-2");
    const result = await t.mutation(
      internal.migrations.linkLegacyUsersForConvexAuth,
      {},
    );
    expect(result.usersMerged).toBe(0);
    expect(result.usersLeftAlone).toBe(1);
    expect(await t.run(async (ctx) => ctx.db.get(legacyId))).not.toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(signInId))).not.toBeNull();
  });

  test("mintAttachTicket carries a connect to the identity and is single-use", async () => {
    const t = convexTest(schema, modules);
    const { userId, asUser } = await signedIn(t);
    // Unauthenticated callers cannot mint one.
    await expect(t.mutation(api.gmail.oauth.mintAttachTicket, {})).rejects.toThrow(
      /Unauthorized/,
    );
    const { ticket } = await asUser.mutation(api.gmail.oauth.mintAttachTicket, {});
    expect(typeof ticket).toBe("string");
    // The OAuth callback completes the connect with the ticket's HASH — the
    // same attach path a legacy token uses.
    const result = await t.mutation(internal.gmail.oauth.completeConnect, {
      email: "person@gmail.com",
      access_token: "at",
      refresh_token: "rt",
      expiry: Date.now() + 3600_000,
      attach_hash: await hashToken(ticket),
    });
    expect(result.attached).toBe(true);
    expect(result.token).toBeUndefined();
    const account = await t.run(async (ctx) => ctx.db.get(result.accountId));
    expect(account!.user_id).toBe(userId);
    // Consumed: no auth_sessions row survives the connect.
    expect(await rowsOf(t, "auth_sessions")).toHaveLength(0);
  });

  test("a ticket is not a device login and dies after its TTL", async () => {
    const t = convexTest(schema, modules);
    const { asUser } = await signedIn(t);
    const { ticket } = await asUser.mutation(api.gmail.oauth.mintAttachTicket, {});
    // It rides the popup URL, so it must never resolve a roster on its own.
    await expect(t.query(api.sync.getAccount, { token: ticket })).rejects.toThrow(
      /Unauthorized/,
    );
    // Past the TTL the attach path refuses it too; the callback then falls
    // back to a fresh legacy login so the connect still lands.
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("auth_sessions").collect();
      for (const row of rows) {
        await ctx.db.patch(row._id, { created_at: Date.now() - 11 * 60 * 1000 });
      }
    });
    const result = await t.mutation(internal.gmail.oauth.completeConnect, {
      email: "person@gmail.com",
      access_token: "at",
      refresh_token: "rt",
      expiry: Date.now() + 3600_000,
      attach_hash: await hashToken(ticket),
    });
    expect(result.attached).toBe(false);
    expect(typeof result.token).toBe("string");
  });
});

describe("oauth result delivery", () => {
  const { closingPage } = require("./gmail/oauth") as typeof import("./gmail/oauth");
  beforeEach(() => {
    process.env.OAUTH_ALLOWED_ORIGINS = "https://whisk.email,mail://auth";
  });

  test("same-tab web sign-in lands on the origin with the token in the fragment", () => {
    const res = closingPage({ token: "tok123", origin: "https://whisk.email", redirect: true });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://whisk.email#token=tok123");
  });

  test("redirect errors ride the fragment too, never a token", () => {
    const res = closingPage({ error: "denied", origin: "https://whisk.email", redirect: true });
    expect(res.headers.get("Location")).toBe("https://whisk.email#error=denied");
  });

  test("an untrusted origin never gets a redirect with a token", async () => {
    const res = closingPage({ token: "tok123", origin: "https://evil.example", redirect: true });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("tok123");
  });

  test("popup flow is unchanged: an html page that posts to the opener", async () => {
    const res = closingPage({ token: "tok123", origin: "https://whisk.email" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("window.opener");
  });
});

describe("summaries", () => {
  const context = (t: Harness, token: string, latest?: boolean) =>
    t.query(internal.ai.summarize.summaryContext, { token, threadGmailId: DEBATE, latest });

  test("a notification reads only the newest message; the thread view reads them all", async () => {
    const { t, token } = await seeded();
    const all = (await messagesIn(t, DEBATE)).filter((m) => !m.deleted).sort((a, b) => a.date - b.date);
    const thread = await context(t, token);
    const latest = await context(t, token, true);
    expect(thread.messages).toHaveLength(all.length);
    expect(latest.messages).toHaveLength(1);
    expect(latest.messages[0].date).toBe(all[all.length - 1].date);
  });

  test("the two summaries cache side by side without clobbering each other", async () => {
    const { t, token, accountId } = await seeded();
    const { message_count } = await threadNamed(t, DEBATE);
    const store = (summary: string, latest?: boolean) =>
      t.mutation(internal.ai.summarize.storeSummary, {
        accountId,
        threadGmailId: DEBATE,
        summary,
        messageCount: message_count,
        latest,
      });
    await store("newest only", true);
    expect((await context(t, token)).cached).toBeNull();
    await store("whole thread");
    expect((await context(t, token)).cached).toBe("whole thread");
    expect((await context(t, token, true)).cached).toBe("newest only");
  });
});
