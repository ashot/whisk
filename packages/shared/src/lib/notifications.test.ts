import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NOTIFICATION_PREFS,
  badgeCount,
  describeLevel,
  describePermission,
  inQuietHours,
  matchesList,
  normalizePrefs,
  notificationContent,
  previewNotifications,
  shouldNotify,
} from "./notifications";
import type { NotificationPrefs } from "./notifications";
import type { Thread } from "../store/types";

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_NOTIFICATION_PREFS,
  ...over,
});

let seq = 0;
function thread(over: Partial<Thread> = {}): Thread {
  seq++;
  return {
    _id: `t${seq}`,
    account_id: "acct1",
    gmail_id: `g${seq}`,
    subject: "Thursday",
    snippet: "works for me",
    participants: [{ email: "me@whisk.email" }, { name: "Ada", email: "ada@lovelace.org" }],
    message_count: 1,
    last_at: 1000 + seq,
    label_ids: ["INBOX"],
    is_unread: true,
    is_starred: false,
    has_attachments: false,
    updated_at: 1000,
    ...over,
  } as Thread;
}

const at = (clock: string, day = 3) => {
  // 2026-09-02 is a Wednesday (day 3); step to the weekday asked for.
  const d = new Date(2026, 8, 2 + (day - 3));
  const [h, m] = clock.split(":").map(Number);
  d.setHours(h, m, 0, 0);
  return d;
};

const ctx = (p: NotificationPrefs, over = {}) => ({ prefs: p, me: { email: "me@whisk.email" }, now: at("12:00"), ...over });

describe("what gets through", () => {
  test("primary mail notifies; a filed lane does not, until its lane is turned on", () => {
    expect(shouldNotify(thread(), ctx(prefs())).notify).toBe(true);

    const promo = thread({ category: "promotions" });
    expect(shouldNotify(promo, ctx(prefs())).reason).toBe("level");
    expect(shouldNotify(promo, ctx(prefs({ level: "all" }))).notify).toBe(true);
    expect(shouldNotify(promo, ctx(prefs({ lanes: { promotions: true } }))).reason).toBe("lane");
    // A lane switched off stays off even when everything else is on.
    expect(shouldNotify(promo, ctx(prefs({ level: "all", lanes: { promotions: false } }))).notify).toBe(false);
  });

  test("the level is a floor: none and vip-only silence ordinary mail", () => {
    expect(shouldNotify(thread(), ctx(prefs({ level: "none" }))).reason).toBe("level");
    expect(shouldNotify(thread(), ctx(prefs({ level: "vip" }))).reason).toBe("level");
    const vip = prefs({ level: "vip", vips: ["ada@lovelace.org"] });
    expect(shouldNotify(thread(), ctx(vip)).reason).toBe("vip");
  });

  test("mute beats everything; VIP beats the lane rules", () => {
    const muted = prefs({ level: "all", muted: ["ada@lovelace.org"], vips: ["ada@lovelace.org"] });
    expect(shouldNotify(thread(), ctx(muted)).reason).toBe("muted");
    // A VIP still comes through from a lane nobody subscribed to.
    const p = prefs({ level: "primary", vips: ["ada@lovelace.org"] });
    expect(shouldNotify(thread({ category: "promotions" }), ctx(p)).reason).toBe("vip");
  });

  test("a whole domain can be listed", () => {
    expect(matchesList("ada@lovelace.org", ["@lovelace.org"])).toBe(true);
    expect(matchesList("ada@lovelace.org", ["@other.org"])).toBe(false);
    const p = prefs({ level: "none", vips: ["@lovelace.org"] });
    expect(shouldNotify(thread(), ctx(p)).notify).toBe(true);
  });

  test("off, read mail, an archived thread and a silenced mailbox all stay quiet", () => {
    expect(shouldNotify(thread(), ctx(prefs({ enabled: false }))).reason).toBe("off");
    expect(shouldNotify(thread({ is_unread: false }), ctx(prefs())).reason).toBe("not-new");
    expect(shouldNotify(thread({ label_ids: [] }), ctx(prefs())).reason).toBe("not-new");
    expect(shouldNotify(thread(), ctx(prefs({ accounts: { acct1: false } }))).reason).toBe("account");
  });

  test("a focused window suppresses the banner unless you asked for it", () => {
    expect(shouldNotify(thread(), ctx(prefs(), { focused: true })).reason).toBe("focused");
    expect(shouldNotify(thread(), ctx(prefs({ whenFocused: true }), { focused: true })).notify).toBe(true);
  });

  test("sound is a property of the verdict, not a second decision", () => {
    expect(shouldNotify(thread(), ctx(prefs())).silent).toBe(false);
    expect(shouldNotify(thread(), ctx(prefs({ sound: false }))).silent).toBe(true);
  });
});

describe("quiet hours", () => {
  const q = (over = {}) => prefs({ quiet: { enabled: true, from: "22:00", to: "08:00", days: [], allowVip: true, ...over } });

  test("a window across midnight covers both sides of it", () => {
    expect(inQuietHours(at("23:30"), q().quiet)).toBe(true);
    expect(inQuietHours(at("07:00"), q().quiet)).toBe(true);
    expect(inQuietHours(at("12:00"), q().quiet)).toBe(false);
    expect(inQuietHours(at("22:00"), q().quiet)).toBe(true);
    expect(inQuietHours(at("08:00"), q().quiet)).toBe(false);
  });

  test("a daytime window is a plain range", () => {
    const day = q({ from: "09:00", to: "17:00" }).quiet;
    expect(inQuietHours(at("12:00"), day)).toBe(true);
    expect(inQuietHours(at("18:00"), day)).toBe(false);
  });

  test("the weekday belongs to the day the window opened", () => {
    // Weeknights only: Wednesday 23:30 is quiet, and so is Thursday 07:00,
    // because that morning belongs to Wednesday night's window.
    const weeknights = q({ days: [3] }).quiet;
    expect(inQuietHours(at("23:30", 3), weeknights)).toBe(true);
    expect(inQuietHours(at("07:00", 4), weeknights)).toBe(true);
    expect(inQuietHours(at("07:00", 5), weeknights)).toBe(false);
  });

  test("an empty window silences nothing", () => {
    expect(inQuietHours(at("22:00"), q({ from: "22:00", to: "22:00" }).quiet)).toBe(false);
  });

  test("VIPs come through unless you close that door too", () => {
    const night = { now: at("23:30") };
    expect(shouldNotify(thread(), ctx(q(), night)).reason).toBe("quiet");
    const vipNight = q();
    vipNight.vips = ["ada@lovelace.org"];
    expect(shouldNotify(thread(), ctx(vipNight, night)).reason).toBe("vip");
    vipNight.quiet.allowVip = false;
    expect(shouldNotify(thread(), ctx(vipNight, night)).reason).toBe("quiet");
  });
});

describe("banner content and badge", () => {
  test("the preview level decides how much lands on the lock screen", () => {
    const t = thread();
    const line = "Ada";
    const summary = "Ada can meet Thursday at 3 and needs you to confirm the room.";
    expect(notificationContent(t, { preview: "full", senderLine: line, summary })).toEqual({ title: "Ada", subtitle: "Thursday", body: summary });
    // No summary yet: the opening of the message, still under the subject.
    expect(notificationContent(t, { preview: "full", senderLine: line })).toEqual({ title: "Ada", subtitle: "Thursday", body: "works for me" });
    // Less discretion never leaks the summary.
    expect(notificationContent(t, { preview: "sender", senderLine: line, summary })).toEqual({ title: "Ada", body: "New message" });
    expect(notificationContent(t, { preview: "none", senderLine: line, summary })).toEqual({ title: "Whisk", body: "New message" });
    expect(notificationContent(thread({ subject: "" }), { preview: "full", senderLine: line })).toEqual({ title: "Ada", body: "works for me" });
    expect(notificationContent(thread({ snippet: "" }), { preview: "full", senderLine: line })).toEqual({ title: "Ada", body: "Thursday" });
    // A newsletter's padded preview reads as its words alone.
    expect(notificationContent(thread({ snippet: "GLM-5.3, KV Cache \u034f \u034f \u034f \u200c" }), { preview: "full", senderLine: line }).body).toBe("GLM-5.3, KV Cache");
  });

  test("the badge counts what its mode says, and honours a silenced mailbox", () => {
    const list = [
      thread(),
      thread({ category: "promotions" }),
      thread({ is_unread: false }),
      thread({ label_ids: [] }),
      thread({ account_id: "acct2" }),
    ];
    expect(badgeCount(list, prefs({ badge: "primary" }))).toBe(2);
    expect(badgeCount(list, prefs({ badge: "inbox" }))).toBe(3);
    expect(badgeCount(list, prefs({ badge: "none" }))).toBe(0);
    expect(badgeCount(list, prefs({ badge: "inbox", accounts: { acct2: false } }))).toBe(2);
  });
});

describe("the settings preview", () => {
  test("counts what would have reached you and why the rest did not", () => {
    const list = [thread(), thread({ category: "promotions" }), thread({ category: "receipts" })];
    const r = previewNotifications(list, {
      prefs: prefs(),
      accountOf: () => ({ email: "me@whisk.email" }),
      now: at("12:00"),
    });
    expect(r).toEqual({ sampled: 3, passed: 1, blocked: { level: 2 } as any });
  });
});

describe("stored prefs", () => {
  test("an empty or half-written object comes back whole", () => {
    expect(normalizePrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    const p = normalizePrefs({ level: "bogus", sound: "yes", vips: ["  ADA@Lovelace.org ", 7, "@X.com"], quiet: { from: "25:00" } });
    expect(p.level).toBe("primary");
    expect(p.sound).toBe(true);
    expect(p.vips).toEqual(["ada@lovelace.org", "@x.com"]);
    expect(p.quiet.from).toBe("22:00");
  });

  test("every level describes itself in words", () => {
    expect(describeLevel(prefs({ enabled: false }))).toContain("off");
    expect(describeLevel(prefs({ level: "vip", vips: ["a@b.c"] }))).toContain("1 important sender");
    expect(describeLevel(prefs({ level: "primary" }))).toContain("Real correspondence");
    expect(describeLevel(prefs({ level: "all" }))).toContain("Everything");
  });
});

describe("pause", () => {
  test("a pause silences everything until it runs out, then stops existing", () => {
    const now = at("12:00");
    const paused = prefs({ pausedUntil: now.getTime() + 60_000 });
    expect(shouldNotify(thread(), ctx(paused, { now })).reason).toBe("paused");
    expect(describeLevel(paused, now.getTime())).toContain("Paused until");
    // Past its moment it is not a rule any more, and it never survives a reload.
    const over = prefs({ pausedUntil: now.getTime() - 1 });
    expect(shouldNotify(thread(), ctx(over, { now })).notify).toBe(true);
    expect(normalizePrefs({ pausedUntil: Date.now() - 1000 }).pausedUntil).toBeUndefined();
    expect(normalizePrefs({ pausedUntil: Date.now() + 60_000 }).pausedUntil).toBeGreaterThan(Date.now());
  });

  test("a VIP does not out-rank a deliberate pause", () => {
    const now = at("12:00");
    const p = prefs({ pausedUntil: now.getTime() + 60_000, vips: ["ada@lovelace.org"] });
    expect(shouldNotify(thread(), ctx(p, { now })).reason).toBe("paused");
  });
});

describe("what the OS is doing with them", () => {
  test("a verified silence explains both causes and offers the one place that fixes either", () => {
    const c = describePermission("silenced");
    expect(c.tone).toBe("warn");
    expect(c.title).toContain("not showing");
    expect(c.body).toContain("alert style");
    expect(c).toMatchObject({ canOpenSettings: true, canAsk: false });
  });

  test("an unproven state never reads as good news", () => {
    for (const s of ["unknown", "silenced", "prompt", "denied"] as const) {
      expect(describePermission(s).tone).not.toBe("ok");
    }
    expect(describePermission("unknown").body).toContain("test");
  });

  test("only a browser that has never asked offers to ask; a blocked one does not pretend it can", () => {
    expect(describePermission("prompt").canAsk).toBe(true);
    expect(describePermission("denied").canAsk).toBe(false);
    expect(describePermission("denied").body).toContain("cannot ask again");
  });

  test("the two working states say so plainly and still allow a test", () => {
    expect(describePermission("showing")).toMatchObject({ tone: "ok", canTest: true });
    expect(describePermission("granted")).toMatchObject({ tone: "ok", canTest: true });
    expect(describePermission("showing", "Aurora").title).toContain("Aurora");
  });

  test("a device with no notifications at all offers nothing to press", () => {
    expect(describePermission("unsupported")).toMatchObject({ canAsk: false, canOpenSettings: false, canTest: false });
  });
});
