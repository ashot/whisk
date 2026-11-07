import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { mailStore } from "../store/mailStore";
import type { Thread } from "../store/types";
import { setAiClient, type AiClient } from "@mail/shared/src/store/aiBridge";

// The store subscription between new mail and the banner: what counts as
// "new", how often a thread may interrupt, and which backend gets it.

const originals = new Map(
  ["window", "document", "Notification"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
// The hash router reads the document at import time; give it one first.
install("document", { title: "Whisk", hasFocus: () => false });
install("window", { location: { hash: "" } });
const { startNotifier } = await import("./notifier");
let banners: Array<{ title: string; options: NotificationOptions }>;
let bridgeCalls: Array<{ title: string; body: string; data: Record<string, unknown> }>;
let badges: number[];
let focused: boolean;
let stop: () => void;
let n = 0;

function install(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

function thread(over: Partial<Thread> = {}): Thread {
  n++;
  return {
    _id: `t-${n}`,
    account_id: "acct",
    gmail_id: `gm-${n}`,
    subject: `Subject ${n}`,
    snippet: "",
    participants: [{ email: "ada@example.com", name: "Ada Lovelace" }],
    message_count: 1,
    last_at: Date.now() + n, // strictly after boot
    label_ids: ["INBOX", "UNREAD"],
    is_unread: true,
    is_starred: false,
    has_attachments: false,
    // Placed inside the sync, as most mail is.
    category_source: "heuristic",
    updated_at: 1,
    ...over,
  } as Thread;
}

// Posting waits on the summary, so a banner lands a few ticks after the mail.
const settle = () => new Promise((r) => setTimeout(r, 0));
const arrive = async (t: Thread) => {
  mailStore.getState().syncTable("threads", [t]);
  await settle();
};

function summarizer(summarize: AiClient["summarizeThread"]) {
  setAiClient({ summarizeThread: summarize } as AiClient);
}

beforeEach(() => {
  banners = [];
  bridgeCalls = [];
  badges = [];
  focused = false;
  install("window", { __WHISK_ELECTRON__: undefined, focus() {}, location: { hash: "" } });
  install("document", { hasFocus: () => focused });
  install(
    "Notification",
    class {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, options: NotificationOptions) {
        banners.push({ title, options });
      }
      close() {}
    },
  );
  mailStore.setState({
    hydrated: true,
    threads: {},
    accounts: { acct: { _id: "acct", email: "me@example.com", provider: "gmail", sync_status: "idle", updated_at: 1 } as any },
    clientState: { notifications: { enabled: true, level: "all" } },
  });
  stop = startNotifier();
});

afterEach(() => {
  stop();
  setAiClient(null);
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("mail that arrives after boot announces once; mail already there never does", async () => {
  const old = thread({ last_at: Date.now() - 60_000 });
  await arrive(old);
  expect(banners).toHaveLength(0);

  const fresh = thread();
  await arrive(fresh);
  expect(banners).toHaveLength(1);
  expect(banners[0].title).toBe("Ada");
  expect(banners[0].options.body).toBe(fresh.subject);
  expect(banners[0].options.tag).toBe(fresh.gmail_id);

  // A label change on the same thread is not news.
  await arrive({ ...fresh, is_starred: true });
  expect(banners).toHaveLength(1);
  // A later message on the same thread is.
  await arrive({ ...fresh, last_at: fresh.last_at + 1000 });
  expect(banners).toHaveLength(2);
});

test("a focused window stays quiet unless asked, and a muted sender always does", async () => {
  focused = true;
  await arrive(thread());
  expect(banners).toHaveLength(0);

  mailStore.getState().setClientPref("notifications", { enabled: true, level: "all", whenFocused: true });
  await arrive(thread());
  expect(banners).toHaveLength(1);

  mailStore.getState().setClientPref("notifications", { enabled: true, level: "all", whenFocused: true, muted: ["@example.com"] });
  await arrive(thread());
  expect(banners).toHaveLength(1);
});

test("the desktop shell takes the banner and the badge when present", async () => {
  (window as any).__WHISK_ELECTRON__ = {
    showNotification: async (title: string, body: string, data: Record<string, unknown>) => {
      bridgeCalls.push({ title, body, data });
      return { shown: true };
    },
    setBadgeCount: async (count: number) => {
      badges.push(count);
    },
  };
  const t = thread();
  await arrive(t);
  expect(banners).toHaveLength(0);
  expect(bridgeCalls).toHaveLength(1);
  expect(bridgeCalls[0].data).toMatchObject({ key: t.gmail_id, kind: "mail", route: `/#t/${t.gmail_id}`, force: false });
  expect(badges.at(-1)).toBe(1);

  await arrive({ ...t, is_unread: false });
  expect(badges.at(-1)).toBe(0);
});

test("the model's summary is the body, under the subject", async () => {
  const asked: string[] = [];
  summarizer(async ({ threadGmailId }) => {
    asked.push(threadGmailId);
    return { summary: "Ada can meet Thursday and needs the room confirmed." };
  });
  const t = thread();
  await arrive(t);
  expect(asked).toEqual([t.gmail_id]);
  expect(banners[0].title).toBe("Ada");
  expect(banners[0].options.body).toBe(`${t.subject}\nAda can meet Thursday and needs the room confirmed.`);

  (window as any).__WHISK_ELECTRON__ = {
    showNotification: async (title: string, body: string, data: Record<string, unknown>) => {
      bridgeCalls.push({ title, body, data });
      return { shown: true };
    },
    setBadgeCount: async () => {},
  };
  const d = thread();
  await arrive(d);
  expect(bridgeCalls[0]).toMatchObject({ title: "Ada", body: "Ada can meet Thursday and needs the room confirmed.", data: { subtitle: d.subject } });
});

test("no summary still banners; mail read while the model writes does not", async () => {
  summarizer(async () => {
    throw new Error("model down");
  });
  const t = thread({ snippet: "Are you free Thursday?" });
  await arrive(t);
  expect(banners[0].options.body).toBe(`${t.subject}\nAre you free Thursday?`);

  let finish: (v: { summary: string }) => void = () => {};
  summarizer(() => new Promise((r) => (finish = r)));
  const read = thread();
  await arrive(read);
  mailStore.getState().syncTable("threads", [{ ...read, is_unread: false }]);
  finish({ summary: "Too late." });
  await settle();
  expect(banners).toHaveLength(1);

  // A summary is never asked for when the banner would not show it.
  const asked: string[] = [];
  summarizer(async ({ threadGmailId }) => (asked.push(threadGmailId), { summary: "x" }));
  mailStore.getState().setClientPref("notifications", { enabled: true, level: "all", preview: "sender" });
  await arrive(thread());
  expect(asked).toEqual([]);
  expect(banners.at(-1)?.options.body).toBe("New message");
});

test("mail the model has not filed yet waits for its lane; a muted lane never banners", async () => {
  mailStore.getState().setClientPref("notifications", { enabled: true, level: "primary", lanes: { newsletters: false } });
  const letter = thread({ category_source: undefined });
  await arrive(letter);
  expect(banners).toHaveLength(0);
  // The model files it as a newsletter: still nothing.
  await arrive({ ...letter, category: "newsletters" as never, category_source: "ai", updated_at: 2 });
  expect(banners).toHaveLength(0);

  // Filed as correspondence: now it announces, once.
  const note = thread({ category_source: undefined });
  await arrive(note);
  expect(banners).toHaveLength(0);
  await arrive({ ...note, category_source: "ai", updated_at: 2 });
  expect(banners).toHaveLength(1);
  await arrive({ ...note, category_source: "ai", updated_at: 3, is_starred: true });
  expect(banners).toHaveLength(1);
});

test("a model that never files the mail cannot swallow it: the wait runs out and the rules decide", async () => {
  jest.useFakeTimers();
  try {
    mailStore.getState().syncTable("threads", [thread({ category_source: undefined })]);
    expect(banners).toHaveLength(0);
    jest.advanceTimersByTime(19_000);
    expect(banners).toHaveLength(0);
    jest.advanceTimersByTime(2_000);
  } finally {
    jest.useRealTimers();
  }
  await settle();
  expect(banners).toHaveLength(1);
});

test("a filter on this mailbox holds the banner until it has judged the mail; other mailboxes' filters do not", async () => {
  const filter = (id: string, account_id: string, last_checked_at: number) =>
    ({ _id: id, account_id, enabled: true, last_checked_at }) as never;
  mailStore.setState({ filters: { other: filter("other", "acct2", 0) } });
  await arrive(thread({ updated_at: 50 }));
  expect(banners).toHaveLength(1);

  mailStore.setState({ filters: { mine: filter("mine", "acct", 0) } });
  await arrive(thread({ updated_at: 50 }));
  expect(banners).toHaveLength(1);
  mailStore.setState({ filters: { mine: filter("mine", "acct", 60) } });
  await settle();
  expect(banners).toHaveLength(2);
});
