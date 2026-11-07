import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { openCredential, sealTokens } from "../lib/credentials";

// Stored Gmail tokens are sealed (lib/credentials.ts); the refresh path writes
// through the seal, so this file needs a key of its own.
process.env.WHISK_CREDENTIALS_KEY ??= Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

const modules = {
  "./_generated/api.js": () => import("../_generated/api.js"),
  "./_generated/server.js": () => import("../_generated/server.js"),
  "./demo.ts": () => import("../demo"),
  "./dispatch.ts": () => import("../dispatch"),
  "./connect.ts": () => import("../connect"),
  "./search.ts": () => import("../search"),
  "./sync.ts": () => import("../sync"),
  "./gmail/pump.ts": () => import("./pump"),
  "./gmail/sync.ts": () => import("./sync"),
  "./gmail/oauth.ts": () => import("./oauth"),
  "./migrations.ts": () => import("../migrations"),
};

type Harness = ReturnType<typeof convexTest>;

async function gmailAccount() {
  const t = convexTest(schema, modules);
  const accountId: Id<"accounts"> = await t.run(
    async (ctx) =>
      await ctx.db.insert("accounts", {
        email: "nora@driftwork.io",
        name: "Nora Adeyemi",
        provider: "gmail" as const,
        sync_status: "idle" as const,
        updated_at: Date.now(),
      }),
  );
  return { t, accountId };
}

const parsed = (over: Record<string, unknown> = {}) => ({
  gmail_id: "m1",
  thread_gmail_id: "t1",
  from: { name: "Theo Brandt", email: "theo@driftwork.io" },
  to: [{ name: "Nora Adeyemi", email: "nora@driftwork.io" }],
  cc: [],
  bcc: [],
  date: 1_000_000,
  snippet: "Reproduced. The retry path rebuilds the request from the draft.",
  body_text: "Reproduced. The retry path rebuilds the request from the draft.",
  label_ids: ["INBOX", "UNREAD"],
  is_unread: true,
  attachments: [],
  subject: "Composer drops attachments on retry",
  ...over,
});

const threads = (t: Harness) => t.run(async (ctx) => await ctx.db.query("threads").collect());
const messages = (t: Harness) =>
  t.run(async (ctx) => await ctx.db.query("messages").collect());

describe("applySyncedMessages", () => {
  test("a synced message builds its thread and derives the row", async () => {
    const { t, accountId } = await gmailAccount();
    await t.mutation(internal.gmail.sync.applySyncedMessages, {
      accountId,
      messages: [
        parsed(),
        parsed({
          gmail_id: "m2",
          date: 2_000_000,
          label_ids: ["INBOX"],
          is_unread: false,
          snippet: "While you are in there: the composer shows the chip.",
          subject: "Re: Composer drops attachments on retry",
          from: { name: "Priya Raman", email: "priya@driftwork.io" },
          attachments: [
            {
              filename: "shot.png",
              mime_type: "image/png",
              size: 40_100,
              gmail_attachment_id: "att1",
            },
          ],
        }),
      ],
    });

    const [thread] = (await threads(t)) as Doc<"threads">[];
    // The subject comes from the EARLIEST message, as Gmail shows it.
    expect(thread.subject).toBe("Composer drops attachments on retry");
    expect(thread.message_count).toBe(2);
    expect(thread.last_at).toBe(2_000_000);
    expect(thread.snippet).toContain("While you are in there");
    expect(thread.label_ids).toEqual(["INBOX", "UNREAD"]);
    expect(thread.is_unread).toBe(true);
    expect(thread.has_attachments).toBe(true);
    expect(thread.participants.map((p) => p.email)).toEqual([
      "theo@driftwork.io",
      "priya@driftwork.io",
    ]);
  });

  test("re-syncing the same message updates rather than duplicates", async () => {
    const { t, accountId } = await gmailAccount();
    await t.mutation(internal.gmail.sync.applySyncedMessages, {
      accountId,
      messages: [parsed()],
    });
    await t.mutation(internal.gmail.sync.applySyncedMessages, {
      accountId,
      messages: [parsed({ label_ids: ["INBOX"], is_unread: false })],
    });

    const rows = (await messages(t)) as Doc<"messages">[];
    expect(rows).toHaveLength(1);
    expect(rows[0].is_unread).toBe(false);
    expect(((await threads(t))[0] as Doc<"threads">).is_unread).toBe(false);
  });

  test("a locally sent row is adopted rather than doubled", async () => {
    const { t, accountId } = await gmailAccount();
    await t.run(async (ctx) => {
      await ctx.db.insert("threads", {
        account_id: accountId,
        gmail_id: "t1",
        subject: "Composer v3",
        snippet: "",
        participants: [],
        message_count: 0,
        last_at: 0,
        label_ids: [],
        is_unread: false,
        is_starred: false,
        has_attachments: false,
        updated_at: Date.now(),
      });
      await ctx.db.insert("messages", {
        account_id: accountId,
        thread_gmail_id: "t1",
        gmail_id: "local-msg-compose-1",
        client_id: "compose-1",
        from: { name: "Nora Adeyemi", email: "nora@driftwork.io" },
        to: [{ email: "theo@driftwork.io" }],
        cc: [],
        bcc: [],
        date: 900_000,
        snippet: "Ship it.",
        body_text: "Ship it.",
        label_ids: ["SENT"],
        is_unread: false,
        attachments: [],
        header_message_id: "<compose-1@mail.local>",
        updated_at: Date.now(),
      });
    });

    // Gmail's history hands the same message back with its real id.
    await t.mutation(internal.gmail.sync.applySyncedMessages, {
      accountId,
      messages: [
        parsed({
          gmail_id: "18real",
          date: 900_000,
          label_ids: ["SENT"],
          is_unread: false,
          header_message_id: "<compose-1@mail.local>",
          from: { name: "Nora Adeyemi", email: "nora@driftwork.io" },
        }),
      ],
    });

    const rows = (await messages(t)) as Doc<"messages">[];
    expect(rows).toHaveLength(1);
    expect(rows[0].gmail_id).toBe("18real");
    // client_id survives so the client's optimistic stub rekeys.
    expect(rows[0].client_id).toBe("compose-1");
  });
});

describe("applyLabelChanges", () => {
  test("a history label delta reaches the message and the thread", async () => {
    const { t, accountId } = await gmailAccount();
    await t.mutation(internal.gmail.sync.applySyncedMessages, {
      accountId,
      messages: [parsed()],
    });

    await t.mutation(internal.gmail.sync.applyLabelChanges, {
      accountId,
      changes: [
        {
          gmail_id: "m1",
          thread_gmail_id: "t1",
          add: ["STARRED"],
          remove: ["UNREAD"],
        },
      ],
    });

    const [message] = (await messages(t)) as Doc<"messages">[];
    expect(message.label_ids).toEqual(["INBOX", "STARRED"]);
    expect(message.is_unread).toBe(false);

    const [thread] = (await threads(t)) as Doc<"threads">[];
    expect(thread.is_unread).toBe(false);
    expect(thread.is_starred).toBe(true);
  });

  test("a change for a message we never synced is skipped", async () => {
    const { t, accountId } = await gmailAccount();
    await t.mutation(internal.gmail.sync.applyLabelChanges, {
      accountId,
      changes: [
        { gmail_id: "ghost", thread_gmail_id: "t9", add: [], remove: ["INBOX"] },
      ],
    });
    expect(await messages(t)).toHaveLength(0);
  });
});

describe("markMessagesDeleted", () => {
  test("a thread survives while one message remains, then goes with the last", async () => {
    const { t, accountId } = await gmailAccount();
    await t.mutation(internal.gmail.sync.applySyncedMessages, {
      accountId,
      messages: [parsed(), parsed({ gmail_id: "m2", date: 2_000_000 })],
    });

    await t.mutation(internal.gmail.sync.markMessagesDeleted, {
      accountId,
      messages: [{ gmail_id: "m2", thread_gmail_id: "t1" }],
    });
    let [thread] = (await threads(t)) as Doc<"threads">[];
    expect(thread.deleted).toBeUndefined();
    expect(thread.message_count).toBe(1);
    expect(thread.last_at).toBe(1_000_000);

    await t.mutation(internal.gmail.sync.markMessagesDeleted, {
      accountId,
      messages: [{ gmail_id: "m1", thread_gmail_id: "t1" }],
    });
    [thread] = (await threads(t)) as Doc<"threads">[];
    expect(thread.deleted).toBe(true);

    // A new message in that thread brings it back rather than leaving a
    // tombstone the client will never show again.
    await t.mutation(internal.gmail.sync.applySyncedMessages, {
      accountId,
      messages: [parsed({ gmail_id: "m3", date: 3_000_000 })],
    });
    [thread] = (await threads(t)) as Doc<"threads">[];
    expect(thread.deleted).toBeUndefined();
    expect(thread.message_count).toBe(1);
    expect(thread.last_at).toBe(3_000_000);
  });
});

describe("upsertLabels", () => {
  test("an unchanged label is not rewritten, a changed one is", async () => {
    const { t, accountId } = await gmailAccount();
    const rows = [
      { gmail_id: "INBOX", name: "Inbox", kind: "system" as const },
      {
        gmail_id: "Label_7",
        name: "Receipts",
        kind: "user" as const,
        color: "#c07a2c",
      },
    ];
    await t.mutation(internal.gmail.sync.upsertLabels, { accountId, labels: rows });
    const first = await t.run(
      async (ctx) => await ctx.db.query("labels").collect(),
    );
    expect(first).toHaveLength(2);
    const stamps = first.map((l) => (l as Doc<"labels">).updated_at);

    await new Promise((resolve) => setTimeout(resolve, 3));
    await t.mutation(internal.gmail.sync.upsertLabels, { accountId, labels: rows });
    const second = (await t.run(
      async (ctx) => await ctx.db.query("labels").collect(),
    )) as Doc<"labels">[];
    // A no-op sync must not advance the client's delta watermark.
    expect(second.map((l) => l.updated_at)).toEqual(stamps);

    await t.mutation(internal.gmail.sync.upsertLabels, {
      accountId,
      labels: [{ ...rows[1], name: "Receipts & invoices" }],
    });
    const renamed = ((await t.run(
      async (ctx) => await ctx.db.query("labels").collect(),
    )) as Doc<"labels">[]).find((l) => l.gmail_id === "Label_7")!;
    expect(renamed.name).toBe("Receipts & invoices");
    expect(renamed.updated_at).toBeGreaterThan(stamps[1]);
  });
});

describe("applySendResult", () => {
  // A demo account, because `applySendResult` does not care about the provider
  // and a demo dispatch writes the same local rows without waking the pump —
  // this test is about the rekey, not about the queue.
  async function sentLocally() {
    const t = convexTest(schema, modules);
    const accountId: Id<"accounts"> = await t.run(
      async (ctx) =>
        await ctx.db.insert("accounts", {
          email: "nora@driftwork.io",
          name: "Nora Adeyemi",
          provider: "demo" as const,
          sync_status: "idle" as const,
          updated_at: Date.now(),
        }),
    );
    const token = await t.run(async (ctx) => {
      const raw = "test-token";
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(raw),
      );
      await ctx.db.insert("auth_sessions", {
        account_id: accountId,
        token_hash: Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
        created_at: Date.now(),
        last_seen_at: Date.now(),
      });
      return raw;
    });
    await t.mutation(api.dispatch.dispatch, {
      token,
      action: "sendMessage",
      args: {
        client_id: "compose-1",
        to: [{ email: "tess@okonkwo.cc" }],
        subject: "Wednesday",
        body_text: "Seven works. I will bring the good shoes.",
      },
    });
    return { t, accountId, token };
  }

  test("local ids are replaced by the ids Gmail assigned", async () => {
    const { t, accountId } = await sentLocally();
    expect(
      ((await threads(t))[0] as Doc<"threads">).gmail_id,
    ).toBe("local-thread-compose-1");

    await t.mutation(internal.gmail.pump.applySendResult, {
      accountId,
      client_id: "compose-1",
      gmail_id: "18real",
      thread_gmail_id: "18realthread",
      label_ids: ["SENT"],
    });

    const [message] = (await messages(t)) as Doc<"messages">[];
    expect(message.gmail_id).toBe("18real");
    expect(message.thread_gmail_id).toBe("18realthread");
    expect(message.client_id).toBe("compose-1");

    const [thread] = (await threads(t)) as Doc<"threads">[];
    expect(thread.gmail_id).toBe("18realthread");
    expect(thread.message_count).toBe(1);
    expect(thread.subject).toBe("Wednesday");
  });

  test("a send Gmail threaded onto a known conversation retires the local stub", async () => {
    const { t, accountId } = await sentLocally();
    await t.mutation(internal.gmail.sync.applySyncedMessages, {
      accountId,
      messages: [parsed({ gmail_id: "existing", thread_gmail_id: "18realthread" })],
    });

    await t.mutation(internal.gmail.pump.applySendResult, {
      accountId,
      client_id: "compose-1",
      gmail_id: "18real",
      thread_gmail_id: "18realthread",
      label_ids: ["SENT"],
    });

    const rows = (await threads(t)) as Doc<"threads">[];
    const local = rows.find((r) => r.gmail_id === "local-thread-compose-1")!;
    const real = rows.find((r) => r.gmail_id === "18realthread")!;
    expect(local.deleted).toBe(true);
    expect(real.deleted).toBeUndefined();
    expect(real.message_count).toBe(2);
    expect(real.label_ids).toContain("SENT");
    expect(real.label_ids).toContain("INBOX");
  });

  test("an unknown client_id is a no-op", async () => {
    const { t, accountId } = await gmailAccount();
    expect(
      await t.mutation(internal.gmail.pump.applySendResult, {
        accountId,
        client_id: "never-sent",
        gmail_id: "x",
        thread_gmail_id: "y",
        label_ids: [],
      }),
    ).toEqual({ rekeyed: false });
  });
});

describe("outbound queue", () => {
  async function queued() {
    const { t, accountId } = await gmailAccount();
    const outboundId = await t.run(
      async (ctx) =>
        await ctx.db.insert("outbound", {
          account_id: accountId,
          kind: "modify" as const,
          payload: { op: "modify", message_gmail_ids: ["m1"] },
          status: "queued" as const,
          attempts: 0,
          created_at: Date.now(),
          updated_at: Date.now(),
        }),
    );
    return { t, accountId, outboundId };
  }

  test("claiming takes the oldest row and counts the attempt", async () => {
    const { t, accountId } = await queued();
    const claimed = await t.mutation(internal.gmail.pump.claimNext, { accountId });
    expect(claimed!.status).toBe("inflight");
    expect(claimed!.attempts).toBe(1);
    // An inflight row is not claimable twice.
    expect(await t.mutation(internal.gmail.pump.claimNext, { accountId })).toBeNull();
  });

  test("a transient failure requeues quietly; giving up surfaces on the account", async () => {
    const { t, accountId, outboundId } = await queued();
    await t.mutation(internal.gmail.pump.claimNext, { accountId });

    await t.mutation(internal.gmail.pump.finish, {
      outboundId,
      status: "queued",
      error: "503 from Gmail",
    });
    let account = (await t.run(async (ctx) => await ctx.db.get(accountId)))!;
    expect(account.sync_status).toBe("idle");
    expect(account.sync_error).toBeUndefined();

    await t.mutation(internal.gmail.pump.finish, {
      outboundId,
      status: "error",
      error: "503 from Gmail",
      surface_on_account: true,
    });
    account = (await t.run(async (ctx) => await ctx.db.get(accountId)))!;
    expect(account.sync_status).toBe("error");
    expect(account.sync_error).toBe("503 from Gmail");

    const row = (await t.run(async (ctx) => await ctx.db.get(outboundId)))!;
    expect(row.status).toBe("error");
  });
});

// The pump and the sync engine are actions that fetch. Stubbing `fetch` lets
// the whole path run for real — schedule, claim, call, write back — with the
// Gmail responses canned.
function stubGmail() {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const original = globalThis.fetch;
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input?.url ?? input);
    let body: any;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    else if (init.body instanceof URLSearchParams) {
      body = Object.fromEntries(init.body.entries());
    }
    calls.push({ url, method: init.method ?? "GET", body });

    if (url.includes("oauth2.googleapis.com/token")) {
      return json({ access_token: "fresh-access-token", expires_in: 3600 });
    }
    if (url.includes("/messages/send")) {
      return json({ id: "18real", threadId: "18realthread", labelIds: ["SENT"] });
    }
    if (url.includes("/history")) return json({ history: [], historyId: "9001" });
    if (/\/drafts(\?|$)/.test(url)) {
      return json({ drafts: [{ id: "r-other", message: { id: "d-other" } }, { id: "r-1", message: { id: "d1" } }] });
    }
    if (url.includes("/profile")) {
      return json({ emailAddress: "nora@driftwork.io", historyId: "9001" });
    }
    return json({});
  }) as typeof fetch;

  return { calls, restore: () => void (globalThis.fetch = original) };
}

async function connected(expiry = Date.now() + 3_600_000) {
  const { t, accountId } = await gmailAccount();
  const token = "gmail-token";
  await t.run(async (ctx) => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(token),
    );
    await ctx.db.insert("auth_sessions", {
      account_id: accountId,
      token_hash: Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
      created_at: Date.now(),
      last_seen_at: Date.now(),
    });
    // Stored the way real rows are: sealed and bound to this account.
    await ctx.db.insert("credentials", {
      account_id: accountId,
      ...(await sealTokens(accountId, {
        access_token: "stored-access-token",
        refresh_token: "stored-refresh-token",
      })),
      expiry,
    });
  });
  process.env.GMAIL_CLIENT_ID = "test-client";
  process.env.GMAIL_CLIENT_SECRET = "test-secret";
  process.env.OAUTH_REDIRECT_URL = "https://example.com/gmail/oauth/callback";
  return { t, accountId, token };
}

/**
 * Scheduled work runs on its own timer here, so a test waits for the end state
 * it cares about rather than for a fixed delay.
 */
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const outboundRows = (t: Harness) =>
  t.run(async (ctx) => await ctx.db.query("outbound").collect());

describe("gmail account wiring", () => {
  test("an archive queues, pumps, and reaches Gmail as one batchModify", async () => {
    const gmail = stubGmail();
    try {
      const { t, accountId, token } = await connected();
      await t.mutation(internal.gmail.sync.applySyncedMessages, {
        accountId,
        messages: [parsed(), parsed({ gmail_id: "m2", date: 2_000_000 })],
      });

      await t.mutation(api.dispatch.dispatch, {
        token,
        action: "applyThreadOps",
        args: { ops: [{ thread_gmail_ids: ["t1"], remove_label_ids: ["INBOX"] }] },
      });

      // A real mailbox leaves the row queued for the pump, unlike the demo.
      const queuedRow = (await t.run(
        async (ctx) => await ctx.db.query("outbound").collect(),
      ))[0] as Doc<"outbound">;
      expect(queuedRow.status).toBe("queued");
      expect(
        (await t.query(api.sync.getAccount, { token })).outbound_pending,
      ).toBe(1);

      await until(
        async () =>
          ((await outboundRows(t))[0] as Doc<"outbound">).status === "done",
        "the modify op to drain",
      );

      const modify = gmail.calls.find((c) => c.url.includes("batchModify"))!;
      expect(modify.body.ids).toEqual(["m1", "m2"]);
      expect(modify.body.removeLabelIds).toEqual(["INBOX"]);
      const settled = (await t.run(
        async (ctx) => await ctx.db.query("outbound").collect(),
      ))[0] as Doc<"outbound">;
      expect(settled.status).toBe("done");
      expect(settled.attempts).toBe(1);
    } finally {
      gmail.restore();
    }
  });

  test("a send goes out as MIME and the real ids come back", async () => {
    const gmail = stubGmail();
    try {
      const { t, token } = await connected();
      await t.mutation(api.dispatch.dispatch, {
        token,
        action: "sendMessage",
        args: {
          client_id: "compose-1",
          to: [{ name: "Tess Okonkwo", email: "tess@okonkwo.cc" }],
          subject: "Wednesday",
          body_text: "Seven works. I will bring the good shoes.",
        },
      });
      await until(
        async () =>
          ((await messages(t))[0] as Doc<"messages">)?.gmail_id === "18real",
        "the send to be written back",
      );

      const send = gmail.calls.find((c) => c.url.includes("/messages/send"))!;
      const mime = new TextDecoder().decode(
        Uint8Array.from(
          atob(send.body.raw.replace(/-/g, "+").replace(/_/g, "/")),
          (c) => c.charCodeAt(0),
        ),
      );
      expect(mime).toContain("To: Tess Okonkwo <tess@okonkwo.cc>");
      expect(mime).toContain("Subject: Wednesday");
      expect(mime).toContain("Message-ID: <compose-1@mail.local>");
      // Not a reply, so Gmail is not told to thread it.
      expect(send.body.threadId).toBeUndefined();

      const [message] = (await messages(t)) as Doc<"messages">[];
      expect(message.gmail_id).toBe("18real");
      expect(message.thread_gmail_id).toBe("18realthread");
      const [thread] = (await threads(t)) as Doc<"threads">[];
      expect(thread.gmail_id).toBe("18realthread");
      expect(
        (await t.query(api.sync.getAccount, { token })).outbound_pending,
      ).toBe(0);
    } finally {
      gmail.restore();
    }
  });

  test("a reply tells Gmail which thread it belongs to", async () => {
    const gmail = stubGmail();
    try {
      const { t, accountId, token } = await connected();
      await t.mutation(internal.gmail.sync.applySyncedMessages, {
        accountId,
        messages: [parsed({ header_message_id: "<parent@driftwork.io>" })],
      });
      await t.mutation(api.dispatch.dispatch, {
        token,
        action: "sendMessage",
        args: {
          client_id: "compose-2",
          to: [{ email: "theo@driftwork.io" }],
          subject: "Re: Composer drops attachments on retry",
          body_text: "Capping the backoff at a minute is right.",
          reply_to_gmail_id: "m1",
        },
      });
      await until(
        async () => gmail.calls.some((c) => c.url.includes("/messages/send")),
        "the reply to be sent",
      );

      const send = gmail.calls.find((c) => c.url.includes("/messages/send"))!;
      expect(send.body.threadId).toBe("t1");
      const mime = atob(
        send.body.raw.replace(/-/g, "+").replace(/_/g, "/"),
      );
      expect(mime).toContain("In-Reply-To: <parent@driftwork.io>");
      expect(mime).toContain("References: <parent@driftwork.io>");
    } finally {
      gmail.restore();
    }
  });

  test("an expired access token is refreshed before the call", async () => {
    const gmail = stubGmail();
    try {
      const { t, accountId, token } = await connected(Date.now() - 1000);
      await t.mutation(internal.gmail.sync.applySyncedMessages, {
        accountId,
        messages: [parsed()],
      });
      await t.mutation(api.dispatch.dispatch, {
        token,
        action: "applyThreadOps",
        args: { ops: [{ thread_gmail_ids: ["t1"], add_label_ids: ["STARRED"] }] },
      });
      await until(
        async () =>
          (await openCredential(((await t.run(
            async (ctx) => await ctx.db.query("credentials").collect(),
          ))[0] as Doc<"credentials">).access_token, accountId, "access_token")) === "fresh-access-token",
        "the access token to be refreshed",
      );

      const refresh = gmail.calls.find((c) =>
        c.url.includes("oauth2.googleapis.com/token"),
      )!;
      expect(refresh.body.grant_type).toBe("refresh_token");
      expect(refresh.body.refresh_token).toBe("stored-refresh-token");

      // The new token is stored, and the old refresh token is kept.
      const credentials = (await t.run(
        async (ctx) => await ctx.db.query("credentials").collect(),
      ))[0] as Doc<"credentials">;
      expect(credentials.access_token.startsWith("enc2:")).toBe(true);
      expect(await openCredential(credentials.access_token, accountId, "access_token")).toBe("fresh-access-token");
      expect(await openCredential(credentials.refresh_token, accountId, "refresh_token")).toBe("stored-refresh-token");
    } finally {
      gmail.restore();
    }
  });

  test("refresh runs an incremental pass and advances the cursor", async () => {
    const gmail = stubGmail();
    try {
      const { t, accountId, token } = await connected();
      await t.run(async (ctx) => {
        await ctx.db.patch(accountId, { history_id: "8000" });
      });

      expect(await t.mutation(api.sync.refresh, { token })).toEqual({
        scheduled: true,
      });
      await until(
        async () =>
          (await t.run(async (ctx) => await ctx.db.get(accountId)))!.history_id ===
          "9001",
        "the history cursor to advance",
      );

      const history = gmail.calls.find((c) => c.url.includes("/history"))!;
      expect(history.url).toContain("startHistoryId=8000");
      const account = (await t.run(
        async (ctx) => await ctx.db.get(accountId),
      ))!;
      expect(account.history_id).toBe("9001");
      expect(account.sync_status).toBe("idle");
      expect(account.last_synced_at).toBeGreaterThan(0);

      // A sync already in flight is not started twice.
      await t.run(async (ctx) => {
        await ctx.db.patch(accountId, { sync_status: "backfilling" });
      });
      expect(await t.mutation(api.sync.refresh, { token })).toEqual({
        scheduled: false,
      });
    } finally {
      gmail.restore();
    }
  });

  test("only connected gmail accounts are woken by the cron", async () => {
    const { t, accountId } = await gmailAccount();
    await t.run(async (ctx) => {
      await ctx.db.insert("accounts", {
        email: "demo@driftwork.io",
        provider: "demo" as const,
        sync_status: "idle" as const,
        updated_at: Date.now(),
      });
      await ctx.db.insert("accounts", {
        email: "midbackfill@driftwork.io",
        provider: "gmail" as const,
        sync_status: "backfilling" as const,
        updated_at: Date.now(),
      });
    });
    const wake = await t.query(internal.gmail.oauth.accountsToSync, {});
    expect(wake).toEqual([accountId]);
  });
});

describe("incremental sync resilience", () => {
  // The wedge this guards against: a multi-page backlog where a later page
  // fails (oversized apply, crash, runtime limit). Before per-page cursor
  // checkpoints, every retry restarted from the ORIGINAL cursor, hit the same
  // failure, and the mailbox never advanced again.
  test("a failed later page does not rewind the cursor past an applied page", async () => {
    const original = globalThis.fetch;
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input?.url ?? input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return json({ access_token: "fresh-access-token", expires_in: 3600 });
      }
      if (url.includes("/history")) {
        if (url.includes("pageToken=p2")) {
          return new Response("boom", { status: 500 });
        }
        return json({
          history: [{ id: "8100" }],
          nextPageToken: "p2",
          historyId: "9500",
        });
      }
      return json({});
    }) as typeof fetch;

    try {
      const { t, accountId } = await connected();
      await t.run(async (ctx) => {
        await ctx.db.patch(accountId, { history_id: "8000" });
      });

      await expect(
        t.action(internal.gmail.sync.incremental, { accountId }),
      ).rejects.toThrow();

      const account = (await t.run(
        async (ctx) => await ctx.db.get(accountId),
      ))!;
      // Page 1 was fully applied, so its last history record is the new
      // cursor; the pre-fix behavior left 8000 here.
      expect(account.history_id).toBe("8100");
      expect(account.sync_status).toBe("error");
      // The stored error keeps the API body, so a 403's reason is readable
      // straight off the account row.
      expect(account.sync_error).toContain("boom");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("full search", () => {
  // Gmail answers a search one page at a time. The action returns the hit
  // rows themselves (search is how a reader reaches mail older than the
  // synced window) and an opaque cursor that walks the remaining pages.
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const message = (threadId: string) => ({
    id: `${threadId}-m1`,
    threadId,
    labelIds: ["INBOX"],
    snippet: `About the wedding (${threadId})`,
    internalDate: String(1_700_000_000_000 + Number(threadId.slice(1)) * 1000),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Kai Okafor <kai@driftwork.io>" },
        { name: "To", value: "Nora Adeyemi <nora@driftwork.io>" },
        { name: "Subject", value: `Wedding plans ${threadId}` },
      ],
      body: { data: Buffer.from("Venue is booked.").toString("base64url") },
    },
  });

  test("pages through Gmail, imports what the projection lacks, returns rows", async () => {
    const original = globalThis.fetch;
    const listCalls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      const url = String(input?.url ?? input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return json({ access_token: "fresh-access-token", expires_in: 3600 });
      }
      const list = url.match(/\/threads\?(.*)$/);
      if (list) {
        listCalls.push(list[1]);
        const params = new URLSearchParams(list[1]);
        expect(params.get("q")).toBe("wedding");
        return params.get("pageToken") === "p2"
          ? json({ threads: [{ id: "w3" }] })
          : json({ threads: [{ id: "w1" }, { id: "w2" }], nextPageToken: "p2" });
      }
      const one = url.match(/\/threads\/(w\d)\?/);
      if (one) return json({ id: one[1], messages: [message(one[1])] });
      return json({});
    }) as typeof fetch;

    try {
      const { t, accountId, token } = await connected();
      // w2 is already synced: the action must not fetch it again.
      await t.mutation(internal.gmail.sync.applySyncedMessages, {
        accountId,
        messages: [parsed({ gmail_id: "w2-m1", thread_gmail_id: "w2", subject: "Wedding plans w2" })],
      });

      const first = await t.action(api.search.runFullSearch, { token, q: "wedding" });
      expect(first.rows.map((r) => r.gmail_id)).toEqual(["w1", "w2"]);
      expect(first.rows[0].subject).toBe("Wedding plans w1");
      expect(first.cursor).not.toBeNull();
      expect(JSON.parse(first.cursor!)).toEqual({ [accountId]: "p2" });

      const second = await t.action(api.search.runFullSearch, {
        token,
        q: "wedding",
        cursor: first.cursor!,
      });
      expect(second.rows.map((r) => r.gmail_id)).toEqual(["w3"]);
      expect(second.cursor).toBeNull();

      // Two list pages; only the two unknown threads were fetched in full.
      expect(listCalls).toHaveLength(2);
      expect(listCalls[1]).toContain("pageToken=p2");
      const rows = await threads(t);
      expect(rows.map((r) => r.gmail_id).sort()).toEqual(["w1", "w2", "w3"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  // A burst of imports trips Gmail's per-user quota. A thread still refused
  // after every retry is a hit all the same: the cursor asks the same page
  // again instead of moving past it, so a long walk never drops results.
  test("asks a page again when Gmail throttles one of its threads", async () => {
    const original = globalThis.fetch;
    let throttle = true;
    globalThis.fetch = (async (input: any) => {
      const url = String(input?.url ?? input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return json({ access_token: "fresh-access-token", expires_in: 3600 });
      }
      if (/\/threads\?/.test(url)) {
        expect(new URLSearchParams(url.split("?")[1]).get("pageToken")).toBeNull();
        return json({ threads: [{ id: "w1" }, { id: "w2" }] });
      }
      const one = url.match(/\/threads\/(w\d)\?/);
      if (one?.[1] === "w1" && throttle) {
        // Retry-After: 0 keeps every retry instant.
        return new Response("rateLimitExceeded", { status: 429, headers: { "Retry-After": "0" } });
      }
      if (one) return json({ id: one[1], messages: [message(one[1])] });
      return json({});
    }) as typeof fetch;

    try {
      const { t, accountId, token } = await connected();
      const first = await t.action(api.search.runFullSearch, { token, q: "wedding" });
      expect(first.rows.map((r) => r.gmail_id)).toEqual(["w2"]);
      expect(JSON.parse(first.cursor!)).toEqual({ [accountId]: "" });

      throttle = false;
      const second = await t.action(api.search.runFullSearch, { token, q: "wedding", cursor: first.cursor! });
      expect(second.rows.map((r) => r.gmail_id)).toEqual(["w1", "w2"]);
      expect(second.cursor).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("gmail drafts", () => {
  const inbound = () => parsed({ header_message_id: "<theo-1@driftwork.io>" });
  const gmailDraft = (over: Record<string, unknown> = {}) =>
    parsed({
      gmail_id: "d1",
      from: { name: "Nora Adeyemi", email: "nora@driftwork.io" },
      to: [{ name: "Theo Brandt", email: "theo@driftwork.io" }],
      date: 2_000_000,
      label_ids: ["DRAFT"],
      is_unread: false,
      in_reply_to: "<theo-1@driftwork.io>",
      subject: "Re: Composer drops attachments on retry",
      body_text: "On it, patch by Friday.\n\nNora\n\nOn Wed, Apr 29, 2026 at 6:14 PM Theo Brandt <theo@driftwork.io> wrote:\n> Reproduced. The retry path rebuilds the request from the draft.",
      ...over,
    });
  const drafts = (t: Harness) => t.run(async (ctx) => await ctx.db.query("drafts").collect());

  test("a draft saved in Gmail syncs in as a reply draft, not a message", async () => {
    const { t, accountId } = await gmailAccount();
    await t.mutation(internal.gmail.sync.applySyncedMessages, { accountId, messages: [inbound(), gmailDraft()] });

    expect((await messages(t)).map((m) => m.gmail_id)).toEqual(["m1"]);
    const [thread] = (await threads(t)) as Doc<"threads">[];
    expect(thread.message_count).toBe(1);
    expect(thread.label_ids).not.toContain("DRAFT");

    const [draft] = (await drafts(t)) as Doc<"drafts">[];
    expect(draft.client_id).toBe("gmail-draft-d1");
    expect(draft.gmail_message_id).toBe("d1");
    expect(draft.mode).toBe("reply");
    expect(draft.thread_gmail_id).toBe("t1");
    expect(draft.reply_to_gmail_id).toBe("m1");
    expect(draft.to).toEqual([{ name: "Theo Brandt", email: "theo@driftwork.io" }]);
    // Whisk replies carry no quoted trail; only what was written comes over.
    expect(draft.body_text).toBe("On it, patch by Friday.\n\nNora");

    // Re-delivery leaves the row (and any edits made in Whisk) alone.
    await t.run(async (ctx) => await ctx.db.patch(draft._id, { body_text: "edited here" }));
    await t.mutation(internal.gmail.sync.applySyncedMessages, { accountId, messages: [gmailDraft()] });
    expect(((await drafts(t))[0] as Doc<"drafts">).body_text).toBe("edited here");
  });

  test("a fresh compose saved in Gmail is a new draft and makes no thread", async () => {
    const { t, accountId } = await gmailAccount();
    await t.mutation(internal.gmail.sync.applySyncedMessages, {
      accountId,
      messages: [gmailDraft({ thread_gmail_id: "t9", in_reply_to: undefined, body_text: "Lunch Thursday?" })],
    });
    expect(await threads(t)).toEqual([]);
    const [draft] = (await drafts(t)) as Doc<"drafts">[];
    expect(draft.mode).toBe("new");
    expect(draft.thread_gmail_id).toBeUndefined();
  });

  test("Gmail dropping the draft (sent, discarded, rewritten) retires it", async () => {
    const { t, accountId } = await gmailAccount();
    await t.mutation(internal.gmail.sync.applySyncedMessages, { accountId, messages: [inbound(), gmailDraft()] });
    await t.mutation(internal.gmail.sync.markMessagesDeleted, {
      accountId,
      messages: [{ gmail_id: "d1", thread_gmail_id: "t1" }],
    });
    expect(((await drafts(t))[0] as Doc<"drafts">).deleted).toBe(true);
    expect(((await threads(t))[0] as Doc<"threads">).deleted).toBeUndefined();
  });

  test("discarding it in Whisk deletes the Gmail draft", async () => {
    const gmail = stubGmail();
    try {
      const { t, accountId, token } = await connected();
      await t.mutation(internal.gmail.sync.applySyncedMessages, { accountId, messages: [inbound(), gmailDraft()] });
      await t.mutation(api.dispatch.dispatch, { token, action: "deleteDraft", args: { client_id: "gmail-draft-d1" } });
      await until(
        async () => ((await outboundRows(t))[0] as Doc<"outbound">)?.status === "done",
        "the draft delete to drain",
      );
      const removed = gmail.calls.filter((c) => c.method === "DELETE");
      expect(removed.map((c) => c.url.replace(/^.*\/gmail\/v1\/users\/me/, ""))).toEqual(["/drafts/r-1"]);
    } finally {
      gmail.restore();
    }
  });

  test("sending it from Whisk deletes the Gmail draft too", async () => {
    const gmail = stubGmail();
    try {
      const { t, accountId, token } = await connected();
      await t.mutation(internal.gmail.sync.applySyncedMessages, { accountId, messages: [inbound(), gmailDraft()] });
      await t.mutation(api.dispatch.dispatch, {
        token,
        action: "sendMessage",
        args: {
          client_id: "gmail-draft-d1",
          to: [{ email: "theo@driftwork.io" }],
          subject: "Re: Composer drops attachments on retry",
          body_text: "On it, patch by Friday.",
          thread_gmail_id: "t1",
          reply_to_gmail_id: "m1",
        },
      });
      await until(
        async () => (await outboundRows(t)).every((r) => (r as Doc<"outbound">).status === "done"),
        "the send and the draft delete to drain",
      );
      expect(gmail.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/drafts/r-1"))).toBe(true);
      expect(((await drafts(t))[0] as Doc<"drafts">).deleted).toBe(true);
    } finally {
      gmail.restore();
    }
  });

  test("a draft that is only the quote it answers has nothing written yet", async () => {
    const { t, accountId } = await gmailAccount();
    await t.mutation(internal.gmail.sync.applySyncedMessages, {
      accountId,
      messages: [
        inbound(),
        gmailDraft({ body_text: "\nOn Wed, Apr 29, 2026 at 6:14 PM Theo Brandt <theo@driftwork.io> wrote:\n> Reproduced." }),
      ],
    });
    expect(((await drafts(t))[0] as Doc<"drafts">).body_text).toBe("");
  });

  test("a reply in a forwarded conversation is still a reply", async () => {
    const { t, accountId } = await gmailAccount();
    await t.mutation(internal.gmail.sync.applySyncedMessages, {
      accountId,
      messages: [
        inbound(),
        gmailDraft({
          subject: "Re: Fwd: Composer drops attachments on retry",
          body_text: "Thanks!\n\nOn Wed, Apr 29, 2026 at 6:14 PM Theo Brandt <theo@driftwork.io> wrote:\n> ---------- Forwarded message ---------\n> From: Yeji <y@x.io>",
        }),
      ],
    });
    const [draft] = (await drafts(t)) as Doc<"drafts">[];
    expect(draft.mode).toBe("reply");
    expect(draft.body_text).toBe("Thanks!");
  });

  test("a forward saved in Gmail stays a forward, content and all", async () => {
    const { t, accountId } = await gmailAccount();
    const body = "FYI\n\n---------- Forwarded message ---------\nFrom: Theo Brandt <theo@driftwork.io>\n\nReproduced.";
    await t.mutation(internal.gmail.sync.applySyncedMessages, {
      accountId,
      messages: [inbound(), gmailDraft({ subject: "Fwd: Composer drops attachments on retry", body_text: body })],
    });
    const [draft] = (await drafts(t)) as Doc<"drafts">[];
    expect(draft.mode).toBe("forward");
    expect(draft.thread_gmail_id).toBeUndefined();
    expect(draft.body_text).toBe(body);
  });

  test("the migration turns stored draft messages into drafts", async () => {
    const { t, accountId } = await gmailAccount();
    await t.mutation(internal.gmail.sync.applySyncedMessages, { accountId, messages: [inbound()] });
    // How a draft was stored before sync knew better.
    await t.run(async (ctx) => {
      const { subject: _subject, ...row } = gmailDraft();
      await ctx.db.insert("messages", { account_id: accountId, ...row, updated_at: Date.now() } as any);
    });
    await t.mutation(internal.migrations.adoptStoredGmailDrafts, {});

    const live = (await messages(t)).filter((m) => !m.deleted);
    expect(live.map((m) => m.gmail_id)).toEqual(["m1"]);
    const [draft] = (await drafts(t)) as Doc<"drafts">[];
    expect(draft.mode).toBe("reply");
    expect(draft.subject).toBe("Composer drops attachments on retry");
    expect(((await threads(t))[0] as Doc<"threads">).message_count).toBe(1);
  });

  test("a refresh repairs adopted drafts and never revives a dropped one", async () => {
    const { t, accountId } = await gmailAccount();
    await t.mutation(internal.gmail.sync.applySyncedMessages, { accountId, messages: [inbound()] });
    await t.run(async (ctx) => {
      const { subject: _a, ...kept } = gmailDraft();
      const { subject: _b, ...dropped } = gmailDraft({ gmail_id: "d2" });
      // d1 was adopted with a stale body; d2 was dropped in Gmail before any draft existed.
      await ctx.db.insert("messages", { account_id: accountId, ...kept, deleted: true, updated_at: 1 } as any);
      await ctx.db.insert("messages", { account_id: accountId, ...dropped, deleted: true, updated_at: 1 } as any);
      await ctx.db.insert("drafts", {
        account_id: accountId,
        client_id: "gmail-draft-d1",
        gmail_message_id: "d1",
        mode: "reply",
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        body_text: "stale",
        updated_at: 1,
      });
    });
    await t.mutation(internal.migrations.adoptStoredGmailDrafts, { refresh: true });
    const rows = (await drafts(t)) as Doc<"drafts">[];
    expect(rows.map((d) => d.client_id)).toEqual(["gmail-draft-d1"]);
    expect(rows[0].body_text).toBe("On it, patch by Friday.\n\nNora");
  });
});
