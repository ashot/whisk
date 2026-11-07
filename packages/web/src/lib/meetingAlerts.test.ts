import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CalendarEvent } from "@mail/shared/src/lib/calendarTypes";
import { mailStore } from "../store/mailStore";
import { alertMeeting } from "./meetingAlerts";
import { meetingKey } from "@mail/shared/src/lib/meetingAlerts";
const originals = new Map(
  ["window", "document", "localStorage", "Notification", "navigator"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)],
  ),
);
let banners: Array<{ title: string; options: NotificationOptions }>;
let storage: Map<string, string>;
let id = 0;
function event(): CalendarEvent {
  return {
    _id: `event-${++id}`,
    account_id: "a",
    calendar_google_id: "work",
    google_id: `event-${id}`,
    summary: "Private discussion",
    start: Date.now() + 120_000,
    end: Date.now() + 180_000,
    status: "confirmed",
    attendees: [],
    all_day: false,
    updated_at: 1,
  };
}
function install(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  });
}
beforeEach(() => {
  banners = [];
  storage = new Map();
  mailStore.setState({
    clientState: { notifications: { enabled: true, preview: "full" } },
    toasts: [],
  });
  install("window", { __WHISK_ELECTRON__: undefined, focus() {} });
  install("document", { hasFocus: () => false });
  install("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    key: (i: number) => [...storage.keys()][i] ?? null,
    get length() {
      return storage.size;
    },
  });
  install(
    "Notification",
    class {
      static permission = "granted";
      constructor(title: string, options: NotificationOptions) {
        banners.push({ title, options });
      }
      close() {}
    },
  );
  let pending = Promise.resolve();
  install("navigator", {
    locks: {
      request: (_key: string, work: () => Promise<void>) => {
        pending = pending.then(work);
        return pending;
      },
    },
  });
});
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
test("concurrent reminder checks and repeat ticks announce once", async () => {
  const row = event();
  await Promise.all([alertMeeting(row), alertMeeting(row)]);
  await alertMeeting(row);
  expect(banners).toHaveLength(1);
  expect(banners[0].title).toBe(row.summary);
  expect(storage.size).toBe(1);
});
test("persisted claims suppress reload duplicates but a new start reminds again", async () => {
  const row = event();
  storage.set(
    `whisk:meeting:${encodeURIComponent(meetingKey(row))}`,
    String(row.end),
  );
  await alertMeeting(row);
  expect(banners).toHaveLength(0);
  await alertMeeting({ ...row, start: row.start + 60_000 });
  expect(banners).toHaveLength(1);
});
test("permission is never requested automatically and hidden previews stay private", async () => {
  (Notification as any).permission = "default";
  const row = event();
  await alertMeeting(row);
  expect(banners).toHaveLength(0);
  expect(storage.size).toBe(0);
  (Notification as any).permission = "granted";
  mailStore.setState({
    clientState: { notifications: { preview: "none", sound: false } },
  });
  await alertMeeting(row);
  expect(banners[0].title).toBe("Upcoming event");
  expect(banners[0].options.silent).toBe(true);
  expect(JSON.stringify(banners)).not.toContain(row.summary);
});
test("a native banner suppressed by the shell does not consume the reminder", async () => {
  let shown = false;
  (window as any).__WHISK_ELECTRON__ = {
    showNotification: async () => ({ shown }),
  };
  const row = event();
  await alertMeeting(row);
  expect(storage.size).toBe(0);
  shown = true;
  await alertMeeting(row);
  expect(storage.size).toBe(1);
});
