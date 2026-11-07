// A tapped push must show the mail it was about: over another open thread,
// under a row id that went stale, and before the thread's row is local.
import { beforeEach, expect, mock, test } from "bun:test";

const pushed: string[] = [];
let dismissed = 0;
mock.module("expo-router", () => ({
  router: {
    canDismiss: () => true,
    dismissAll: () => void dismissed++,
    push: (to: { params: { id: string } }) => void pushed.push(to.params.id),
  },
  useNavigationContainerRef: () => ({ isReady: () => true }),
}));
mock.module("expo-notifications", () => ({ setNotificationHandler: () => {}, AndroidImportance: {} }));
mock.module("expo-device", () => ({ isDevice: false }));
mock.module("expo-constants", () => ({ default: {} }));
mock.module("expo-secure-store", () => ({ AFTER_FIRST_UNLOCK: 0, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
mock.module("expo-crypto", () => ({ randomUUID: () => "uuid" }));
mock.module("react-native", () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) }, Platform: { OS: "ios" } }));
mock.module("./kv", () => ({ sqliteKV: {} }));
mock.module("./auth", () => ({ refreshSync: async () => {} }));

let server: { rows: unknown[]; messages: unknown[] } = { rows: [], messages: [] };
mock.module("./convex", () => ({
  convexClient: () => ({
    query: async (_ref: unknown, args: Record<string, unknown>) => ("gmailIds" in args ? server.rows : server.messages),
  }),
}));

const { mailStore } = await import("@mail/shared/src/store/mailStore");
const { open } = await import("./push");

const row = (id: string, gmail: string, extra: object = {}) => ({
  _id: id, account_id: "acct", gmail_id: gmail, subject: `Subject ${gmail}`, snippet: "", participants: [], message_count: 1,
  last_at: 1, label_ids: ["INBOX", "UNREAD"], is_unread: true, is_starred: false, has_attachments: false, updated_at: 1, ...extra,
});
const st = () => mailStore.getState() as any;
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  pushed.length = 0;
  dismissed = 0;
  server = { rows: [], messages: [] };
  mailStore.setState({ threads: {}, threadMessages: {}, openThreadId: null, authToken: "tok", hydrated: true } as never);
});

test("a tap while another thread is open shows the tapped mail, not the one that was open", async () => {
  mailStore.setState({ threads: { a: row("a", "ga"), b: row("b", "gb") } } as never);
  st().openThread("a");
  open({ kind: "mail", thread_id: "b", thread_gmail_id: "gb", account_id: "acct" });
  expect(dismissed).toBe(1);
  expect(pushed).toEqual(["b"]);
  expect(st().openThreadId).toBe("b");
  await settle();
});

test("a push whose row id went stale opens the local row with the same Gmail id", async () => {
  mailStore.setState({ threads: { fresh: row("fresh", "gb") } } as never);
  open({ kind: "mail", thread_id: "stale", thread_gmail_id: "gb", account_id: "acct" });
  expect(pushed).toEqual(["fresh"]);
  expect(st().openThreadId).toBe("fresh");
  await settle();
});

test("a tap ahead of the sync fetches the row and its messages, and marks the thread read once it is here", async () => {
  server = { rows: [row("c", "gc")], messages: [{ _id: "m1", gmail_id: "m1", thread_gmail_id: "gc" }] };
  open({ kind: "mail", thread_id: "c", thread_gmail_id: "gc", account_id: "acct" });
  expect(st().openThreadId).toBe("c");
  await settle();
  expect(st().threads.c?.subject).toBe("Subject gc");
  expect(st().threadMessages.gc).toHaveLength(1);
  expect(st().threads.c.is_unread).toBe(false);
});

test("a digest opens the inbox, and a signed out app stays on its welcome screen", () => {
  open({ kind: "mail-digest", account_id: "acct" });
  expect(dismissed).toBe(1);
  expect(pushed).toEqual([]);
  mailStore.setState({ authToken: null } as never);
  open({ kind: "mail", thread_id: "b", thread_gmail_id: "gb", account_id: "acct" });
  expect(pushed).toEqual([]);
});
