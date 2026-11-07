// Who gets to interrupt you, and how loudly.
//
// One pure decision — `shouldNotify` — sits between new mail and the OS
// banner, so the desktop shell, the settings preview that shows what WOULD
// have interrupted you, and any future mobile client all answer the question
// the same way. No Electron, no DOM, no store: a thread, the prefs, and the
// clock in; a verdict out.

import type { CategoryId } from "./categories";
import type { Address, Thread } from "../store/types";
import { isOwnAddress, type Sender } from "./sendAs";

export type NotifyLevel = "all" | "primary" | "vip" | "none";
export type PreviewLevel = "full" | "sender" | "none";
export type BadgeMode = "primary" | "inbox" | "none";

export type QuietHours = {
  enabled: boolean;
  /** "22:00" — local wall clock. */
  from: string;
  to: string;
  /** Weekdays it applies to, 0 = Sunday. Empty means every day. */
  days: number[];
  /** People on the VIP list still get through. */
  allowVip: boolean;
};

export type NotificationPrefs = {
  enabled: boolean;
  /** The one choice that decides most of it; lanes and lists refine it. */
  level: NotifyLevel;
  /** Per-lane override of `level`. Absent = whatever `level` says. */
  lanes: Partial<Record<CategoryId, boolean>>;
  /** Per-mailbox switch, keyed by account id. Absent = on. */
  accounts: Record<string, boolean>;
  /** Always interrupt (an address, or "@domain.com" for everyone there). */
  vips: string[];
  /** Never interrupt, whatever else says. */
  muted: string[];
  sound: boolean;
  preview: PreviewLevel;
  /** Interrupt even while a Whisk window is in front of you. */
  whenFocused: boolean;
  quiet: QuietHours;
  badge: BadgeMode;
  /** Silence everything until this moment (epoch ms) — the "not now" that
   *  every real notification surface needs. Absent or past = not paused. */
  pausedUntil?: number;
};

// Quiet by default in the lanes Whisk files for you: a receipt is not worth a
// banner, and someone who turns notifications on should not have to turn eight
// things off before their machine stops buzzing.
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  level: "primary",
  lanes: {},
  accounts: {},
  vips: [],
  muted: [],
  sound: true,
  preview: "full",
  whenFocused: false,
  quiet: { enabled: false, from: "22:00", to: "08:00", days: [], allowVip: true },
  badge: "primary",
};

/** Fill in anything a stored (or older) prefs object is missing. */
export function normalizePrefs(raw: unknown): NotificationPrefs {
  const p = (raw ?? {}) as Partial<NotificationPrefs>;
  const d = DEFAULT_NOTIFICATION_PREFS;
  const list = (v: unknown, fallback: string[]) =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map(normalizeMatcher).filter(Boolean))] : fallback;
  const quiet = (p.quiet ?? {}) as Partial<QuietHours>;
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : d.enabled,
    level: isLevel(p.level) ? p.level : d.level,
    lanes: p.lanes && typeof p.lanes === "object" ? { ...p.lanes } : {},
    accounts: p.accounts && typeof p.accounts === "object" ? { ...p.accounts } : {},
    vips: list(p.vips, d.vips),
    muted: list(p.muted, d.muted),
    sound: typeof p.sound === "boolean" ? p.sound : d.sound,
    preview: isPreview(p.preview) ? p.preview : d.preview,
    whenFocused: typeof p.whenFocused === "boolean" ? p.whenFocused : d.whenFocused,
    quiet: {
      enabled: typeof quiet.enabled === "boolean" ? quiet.enabled : d.quiet.enabled,
      from: isClock(quiet.from) ? quiet.from : d.quiet.from,
      to: isClock(quiet.to) ? quiet.to : d.quiet.to,
      days: Array.isArray(quiet.days) ? quiet.days.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6) : [],
      allowVip: typeof quiet.allowVip === "boolean" ? quiet.allowVip : d.quiet.allowVip,
    },
    badge: isBadge(p.badge) ? p.badge : d.badge,
    ...(typeof p.pausedUntil === "number" && p.pausedUntil > Date.now() ? { pausedUntil: p.pausedUntil } : {}),
  };
}

const isLevel = (v: unknown): v is NotifyLevel => v === "all" || v === "primary" || v === "vip" || v === "none";
const isPreview = (v: unknown): v is PreviewLevel => v === "full" || v === "sender" || v === "none";
const isBadge = (v: unknown): v is BadgeMode => v === "primary" || v === "inbox" || v === "none";
const isClock = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** An address or an "@domain" rule, lowercased and trimmed. */
export function normalizeMatcher(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("@")) return s.length > 1 ? s : "";
  return s;
}

/** Does this address match a list entry — the address itself, or its domain
 *  when the entry is written "@example.com"? */
export function matchesList(email: string, list: string[]): boolean {
  const addr = email.trim().toLowerCase();
  if (!addr) return false;
  const domain = addr.slice(addr.indexOf("@"));
  return list.some((entry) => (entry.startsWith("@") ? entry === domain : entry === addr));
}

/** The other party on a thread — who the notification is "from". */
export function counterparty(t: Thread, me?: Sender): Address | null {
  const other = t.participants.find((p) => !me || !isOwnAddress(me, p.email));
  return other ?? t.participants[0] ?? null;
}

function minutesOf(clock: string): number {
  const [h, m] = clock.split(":");
  return Number(h) * 60 + Number(m);
}

/** Is `now` inside the quiet window? Handles a window that crosses midnight,
 *  where the weekday it belongs to is the day it STARTED. */
export function inQuietHours(now: Date, q: QuietHours): boolean {
  if (!q.enabled) return false;
  const from = minutesOf(q.from);
  const to = minutesOf(q.to);
  if (from === to) return false; // an empty window silences nothing
  const minute = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();
  const onDay = (d: number) => q.days.length === 0 || q.days.includes(d);
  if (from < to) return minute >= from && minute < to && onDay(today);
  // Wraps midnight: tonight's tail, or this morning's head from yesterday.
  if (minute >= from) return onDay(today);
  if (minute < to) return onDay((today + 6) % 7);
  return false;
}

/** Still news: unread, in the inbox, not deleted. Mail read or archived on
 *  another device in the meantime no longer earns a banner. */
export function unreadInInbox(t: Pick<Thread, "is_unread" | "label_ids" | "deleted">): boolean {
  return !t.deleted && t.is_unread && t.label_ids.includes("INBOX");
}

export type NotifyReason =
  | "ok"
  | "vip"
  | "off"
  | "not-new"
  | "account"
  | "muted"
  | "lane"
  | "level"
  | "quiet"
  | "paused"
  | "focused"
  | "hidden";

export type NotifyDecision = {
  notify: boolean;
  /** Why — the settings preview and the tests both read this. */
  reason: NotifyReason;
  /** Post it without a sound. */
  silent: boolean;
};

export type NotifyContext = {
  prefs: NotificationPrefs;
  /** The mailbox the thread belongs to, so none of my addresses counts as
   *  the sender. */
  me?: Sender;
  now?: Date;
  /** A Whisk window is in front of the person right now. */
  focused?: boolean;
  /** Skip the unread/inbox check when the caller already knows it is new. */
  assumeNew?: boolean;
  /** The person's topics; a thread in a muted one never interrupts. */
  clusters?: Record<string, { hidden?: boolean; deleted?: boolean; parent_id?: string }>;
};

/**
 * Should this thread interrupt? Order matters: mute beats everything, VIP
 * beats the lane rules and (optionally) quiet hours, and the lane override
 * beats the broad level.
 */
export function shouldNotify(t: Thread, ctx: NotifyContext): NotifyDecision {
  const { prefs } = ctx;
  const no = (reason: NotifyReason): NotifyDecision => ({ notify: false, reason, silent: true });
  const yes = (reason: NotifyReason): NotifyDecision => ({ notify: true, reason, silent: !prefs.sound });

  if (!prefs.enabled) return no("off");
  const nowMs = (ctx.now ?? new Date()).getTime();
  if (prefs.pausedUntil && nowMs < prefs.pausedUntil) return no("paused");
  if (!ctx.assumeNew && !unreadInInbox(t)) return no("not-new");
  if (ctx.focused && !prefs.whenFocused) return no("focused");
  if (prefs.accounts[t.account_id] === false) return no("account");

  const from = counterparty(t, ctx.me);
  const email = from?.email ?? "";
  if (email && matchesList(email, prefs.muted)) return no("muted");
  if (inHiddenTopic(t, ctx.clusters)) return no("hidden");

  const now = ctx.now ?? new Date();
  const quiet = inQuietHours(now, prefs.quiet);
  const vip = !!email && matchesList(email, prefs.vips);

  if (vip) return quiet && !prefs.quiet.allowVip ? no("quiet") : yes("vip");
  if (quiet) return no("quiet");
  if (prefs.level === "none" || prefs.level === "vip") return no("level");

  // The lane the thread was filed into; primary correspondence has none.
  const lane = t.category;
  if (lane) {
    const override = prefs.lanes[lane];
    if (override === true) return yes("lane");
    if (override === false) return no("lane");
    return prefs.level === "all" ? yes("level") : no("level");
  }
  // Primary: an override of `false` on nothing cannot exist, so level decides.
  return yes("level");
}

/** Title, subtitle and body for the banner, at the chosen level of
 *  discretion. At full preview the sender is the title, the subject the
 *  subtitle, and the body says what the mail is about: the model's summary
 *  when there is one, else the opening of the message. */
export function notificationContent(
  t: Thread,
  opts: { preview: PreviewLevel; senderLine: string; summary?: string },
): { title: string; subtitle?: string; body: string } {
  if (opts.preview === "none") return { title: "Whisk", body: "New message" };
  const title = opts.senderLine || "New mail";
  if (opts.preview === "sender") return { title, body: "New message" };
  const subject = t.subject.trim();
  // Newsletters pad their preview text with invisible joiners; drop them.
  const text = (opts.summary || t.snippet).replace(/[\u034f\u00ad\u200b-\u200d\u2060\ufeff]/g, "").replace(/\s+/g, " ").trim();
  if (!text) return { title, body: subject || "New message" };
  return { title, ...(subject ? { subtitle: subject } : {}), body: text };
}

/** The longest a notification waits for the model work that can change its
 *  answer (the lane a thread is filed into, the person's filters). It goes
 *  out the moment that work is done; this is only the ceiling for a slow
 *  model. */
export const MODEL_WAIT_MAX_MS = 20 * 1000;

/** Has the model said everything that could change what these threads earn?
 *  A thread is placed once its lane has a source (a rule and a heuristic place
 *  it inside the sync itself, so most mail never waits). A filter has spoken
 *  once it has checked mail since the sync that brought these threads. */
export function modelWorkSettled(input: {
  threads: Array<{ category_source?: string }>;
  filters: Array<{ enabled: boolean; last_checked_at?: number }>;
  since: number;
  modelOn: boolean;
}): boolean {
  if (!input.modelOn) return true;
  return (
    input.threads.every((t) => !!t.category_source) &&
    input.filters.every((f) => !f.enabled || (f.last_checked_at ?? 0) >= input.since)
  );
}

/** Whether a banner at this preview level shows what the mail says, and so
 *  is worth waiting a moment for the model's summary. */
export const previewWantsSummary = (preview: PreviewLevel): boolean => preview === "full";

/** The longest a banner waits for that summary before it goes out with the
 *  opening of the message instead. */
export const SUMMARY_WAIT_MS = 8 * 1000;

/** What the dock badge counts. */
/** Whether a thread sits in a topic the person muted, directly or through
 *  the theme its stream sits in. */
export function inHiddenTopic(t: { cluster_id?: string }, clusters?: NotifyContext["clusters"]): boolean {
  const c = t.cluster_id ? clusters?.[t.cluster_id] : undefined;
  if (!c || c.deleted) return false;
  if (c.hidden) return true;
  const parent = c.parent_id ? clusters?.[c.parent_id] : undefined;
  return !!parent && !parent.deleted && !!parent.hidden;
}

export function badgeCount(threads: Thread[], prefs: NotificationPrefs, clusters?: NotifyContext["clusters"]): number {
  if (prefs.badge === "none") return 0;
  return threads.filter(
    (t) =>
      unreadInInbox(t) &&
      prefs.accounts[t.account_id] !== false &&
      !inHiddenTopic(t, clusters) &&
      (prefs.badge === "inbox" || !t.category),
  ).length;
}

/** How the current rules would have treated recent mail — the honest answer
 *  to "so what will actually reach me?", shown in settings. */
export function previewNotifications(
  threads: Thread[],
  ctx: { prefs: NotificationPrefs; accountOf: (accountId: string) => Sender | undefined; now?: Date; sample?: number },
): { sampled: number; passed: number; blocked: Record<NotifyReason, number> } {
  const recent = threads
    .filter((t) => !t.deleted && t.label_ids.includes("INBOX"))
    .sort((a, b) => b.last_at - a.last_at)
    .slice(0, ctx.sample ?? 50);
  const blocked = {} as Record<NotifyReason, number>;
  let passed = 0;
  for (const t of recent) {
    const d = shouldNotify(t, {
      prefs: ctx.prefs,
      me: ctx.accountOf(t.account_id),
      now: ctx.now,
      assumeNew: true,
    });
    if (d.notify) passed++;
    else blocked[d.reason] = (blocked[d.reason] ?? 0) + 1;
  }
  return { sampled: recent.length, passed, blocked };
}

/** "3:40pm" — the short local time a pause runs out. */
export function formatClock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** One line describing what gets through, for the settings summary. */
export function describeLevel(prefs: NotificationPrefs, now = Date.now()): string {
  if (!prefs.enabled) return "Notifications are off";
  if (prefs.pausedUntil && now < prefs.pausedUntil) {
    return `Paused until ${formatClock(new Date(prefs.pausedUntil))}`;
  }
  switch (prefs.level) {
    case "none":
      return "Nothing interrupts you";
    case "vip":
      return prefs.vips.length
        ? `Only your ${prefs.vips.length} important ${prefs.vips.length === 1 ? "sender" : "senders"}`
        : "Only important senders — add some below";
    case "primary":
      return "Real correspondence only — filed lanes stay quiet";
    case "all":
      return "Everything that lands in the inbox";
  }
}

// ——— what the operating system is doing with our notifications ———
//
// A person who turns notifications on and sees nothing is owed a straight
// answer about where they are being stopped. The app can be told to notify,
// the rules above can allow a thread through, and the OS can still drop the
// banner — so the settings panel names which of those is true.
//
// `showing` and `silenced` are verified: the desktop shell posts a
// notification and reads back how the OS presented it. `granted`, `prompt`
// and `denied` come from a browser, which reports its own permission but not
// whether anything is drawn. `unknown` is the honest gap, and never reads as
// good news.

export type OsNotifyState =
  | "showing"
  | "silenced"
  | "unknown"
  | "granted"
  | "prompt"
  | "denied"
  | "unsupported";

export type PermissionCopy = {
  /** ok = nothing to do, warn = notifications cannot arrive, neutral = unproven. */
  tone: "ok" | "warn" | "neutral";
  title: string;
  body?: string;
  /** Which affordances make sense in this state. */
  canAsk: boolean;
  canOpenSettings: boolean;
  canTest: boolean;
};

export function describePermission(state: OsNotifyState, product = "Whisk"): PermissionCopy {
  switch (state) {
    case "showing":
      return { tone: "ok", title: `Your system is showing ${product}'s notifications`, canAsk: false, canOpenSettings: true, canTest: true };
    case "silenced":
      return {
        tone: "warn",
        title: `Your system is not showing ${product}'s notifications`,
        // Both causes look identical from outside the OS, and one trip to the
        // same pane fixes either, so the sentence covers both rather than
        // guessing and being confidently wrong half the time.
        body: `Everything below is set, but macOS is dropping the banners — either ${product} is not allowed to notify you, or its alert style is set to None. Both live in one place.`,
        canAsk: false,
        canOpenSettings: true,
        canTest: true,
      };
    case "granted":
      return { tone: "ok", title: "Your browser is allowing notifications", canAsk: false, canOpenSettings: false, canTest: true };
    case "prompt":
      return {
        tone: "warn",
        title: "Your browser has not been asked yet",
        body: `Until you allow them, ${product} cannot show a notification at all.`,
        canAsk: true,
        canOpenSettings: false,
        canTest: false,
      };
    case "denied":
      return {
        tone: "warn",
        title: "Your browser is blocking notifications",
        body: "A blocked site cannot ask again. Allow notifications for this site in your browser's settings, then reload.",
        canAsk: false,
        canOpenSettings: false,
        canTest: false,
      };
    case "unsupported":
      return { tone: "neutral", title: "This device cannot show notifications", canAsk: false, canOpenSettings: false, canTest: false };
    default:
      return {
        tone: "neutral",
        title: "Not sure whether your system is showing them",
        body: "Send a test and Whisk will report what actually happened.",
        canAsk: false,
        canOpenSettings: true,
        canTest: true,
      };
  }
}
