// New mail becomes a banner here, and nowhere else.
//
// One subscription watches the store, asks the shared rules whether each new
// thread is worth interrupting for, and posts through whichever backend this
// build has: the desktop shell's native banners, or the browser's own. The
// dock badge rides the same subscription.
import { mailStore } from "../store/mailStore";
import { L, type Thread } from "../store/types";
import { participantsLine } from "@mail/shared/src/lib/format";
import { desktopBridge } from "./desktopBridge";
import { aiAvailable, aiClient } from "@mail/shared/src/store/aiBridge";
import { threadHash } from "../sync/hashRouter";
import {
  badgeCount,
  counterparty,
  MODEL_WAIT_MAX_MS,
  modelWorkSettled,
  notificationContent,
  notificationPrefs,
  previewWantsSummary,
  shouldNotify,
  SUMMARY_WAIT_MS,
  unreadInInbox,
  type NotificationPrefs,
  type OsNotifyState,
} from "./notifications";

/** The model's summary of the thread's newest message, the one the phone
 *  push already asked for, or nothing if it is not ready in time. */
async function summaryFor(t: Thread, prefs: NotificationPrefs): Promise<string | undefined> {
  if (!previewWantsSummary(prefs.preview) || !aiAvailable()) return undefined;
  const late = new Promise<undefined>((r) => setTimeout(() => r(undefined), SUMMARY_WAIT_MS));
  const asked = aiClient()
    .summarizeThread({ threadGmailId: t.gmail_id, accountId: t.account_id, timeoutMs: SUMMARY_WAIT_MS, latest: true })
    .then((r) => r.summary)
    .catch(() => undefined);
  return Promise.race([asked, late]);
}

async function post(t: Thread, prefs: NotificationPrefs, silent: boolean): Promise<void> {
  const me = mailStore.getState().accounts[t.account_id];
  const summary = await summaryFor(t, prefs);
  // Read or archived while the model wrote: not news any more.
  const now = mailStore.getState().threads[t._id];
  if (now && !unreadInInbox(now)) return;
  const { title, subtitle, body } = notificationContent(t, {
    preview: prefs.preview,
    senderLine: participantsLine(t, me),
    summary,
  });
  const open = () => {
    window.location.hash = threadHash(t.gmail_id);
    const row = mailStore.getState().threads[t._id];
    if (row) mailStore.getState().openThread(t._id);
  };

  const bridge = desktopBridge();
  if (bridge) {
    // The shell owns the banner: it collapses duplicates across windows and
    // routes the click. `force` tells it this one survived our focus rule.
    void bridge.showNotification(title, body, {
      subtitle,
      route: `/${threadHash(t.gmail_id)}`,
      key: t.gmail_id,
      kind: "mail",
      silent,
      force: prefs.whenFocused,
    });
    // Give the system a moment to present it, then confirm it did.
    setTimeout(() => void checkSystemIsShowing(), 2500);
    return;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  // A browser banner has no subtitle line; the subject leads the body.
  const n = new Notification(title, { body: subtitle ? `${subtitle}\n${body}` : body, tag: t.gmail_id, silent });
  n.onclick = () => {
    window.focus();
    open();
    n.close();
  };
}

/**
 * Post one banner with the current rules and say what became of it — the
 * "try it" button in settings. On desktop the shell reads the system's own
 * verdict back, so this reports whether the notification was actually drawn
 * rather than that it was handed over.
 */
export async function sendTestNotification(): Promise<{ ok: boolean; state: OsNotifyState; reason?: string }> {
  const prefs = notificationPrefs();
  const bridge = desktopBridge();
  const body = prefs.preview === "none" ? "New message" : "This is what new mail looks like.";

  if (bridge?.testNotification) {
    const r = await bridge.testNotification({ title: "Whisk", body, silent: !prefs.sound });
    const state = (r?.status ?? "unknown") as OsNotifyState;
    return {
      ok: state === "showing",
      state,
      reason:
        state === "silenced"
          ? "Sent, but your system did not show it"
          : state === "showing"
            ? undefined
            : "Sent — could not tell whether it appeared",
    };
  }
  if (typeof Notification === "undefined") return { ok: false, state: "unsupported", reason: "This browser has no notifications." };
  if (Notification.permission !== "granted") {
    return { ok: false, state: Notification.permission === "denied" ? "denied" : "prompt", reason: "Your browser has not allowed notifications yet." };
  }
  new Notification("Whisk", { body, silent: !prefs.sound });
  return { ok: true, state: "granted" };
}

/**
 * Watch for mail that arrived after this tab opened and announce what the
 * rules allow. A thread announces once per arrival: `last_at` moving forward
 * is a new message, so a long thread can interrupt again, but a re-render or a
 * label change never can. An arrival waits, as the phone's push does, until
 * the model has filed it and the person's filters have judged it, so mail
 * bound for a quiet lane never banners on the way there.
 */
export function startNotifier(): () => void {
  const bootAt = Date.now();
  const seen = new Map<string, number>();
  // Arrivals the model may still file: the server clock the row carried when
  // it first showed up, and the local moment to stop waiting.
  const pending = new Map<string, { since: number; deadline: number }>();
  let badge = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = (s: ReturnType<typeof mailStore.getState>) => {
    if (!s.hydrated) return;
    const prefs = notificationPrefs();
    const inbox = (Object.values(s.threads) as Thread[]).filter(
      (t) => !t.deleted && t.label_ids.includes(L.INBOX),
    );

    const count = badgeCount(inbox, prefs, s.clusters);
    if (count !== badge) {
      badge = count;
      void desktopBridge()?.setBadgeCount(count);
    }

    const now = Date.now();
    for (const t of inbox) {
      // Mail already in the mailbox when this tab opened is history, not news.
      const prev = seen.get(t._id) ?? bootAt;
      seen.set(t._id, Math.max(prev, t.last_at));
      if (t.last_at > prev) pending.set(t._id, { since: t.updated_at, deadline: now + MODEL_WAIT_MAX_MS });
    }

    const focused = typeof document !== "undefined" && document.hasFocus();
    for (const [id, wait] of pending) {
      const t = s.threads[id] as Thread | undefined;
      if (!t || !unreadInInbox(t)) {
        pending.delete(id);
        continue;
      }
      const filters = Object.values(s.filters).filter((f) => f.account_id === t.account_id && !f.deleted);
      if (now < wait.deadline && !modelWorkSettled({ threads: [t], filters, since: wait.since, modelOn: true })) continue;
      pending.delete(id);
      const decision = shouldNotify(t, {
        prefs,
        me: s.accounts[t.account_id],
        focused,
        clusters: s.clusters,
      });
      if (decision.notify) void post(t, prefs, decision.silent);
    }

    // A slow model may never write again; the deadline still has to fire.
    clearTimeout(timer);
    if (pending.size > 0) {
      const next = Math.min(...[...pending.values()].map((w) => w.deadline));
      timer = setTimeout(() => run(mailStore.getState()), Math.max(0, next - Date.now()));
    }
  };

  const unsubscribe = mailStore.subscribe(run);
  return () => {
    unsubscribe();
    clearTimeout(timer);
  };
}

// Told once per run, the first time a banner goes out and the system turns
// out to be dropping it. Silence about it is the failure the person already
// experienced; saying it twice is nagging.
let toldAboutSilence = false;

async function checkSystemIsShowing(): Promise<void> {
  if (toldAboutSilence) return;
  const bridge = desktopBridge();
  if (!bridge?.getNotificationStatus) return;
  toldAboutSilence = true;
  try {
    const s = await bridge.getNotificationStatus({ refresh: true });
    if (s?.status !== "silenced") return;
    mailStore
      .getState()
      .pushToast("Your system is not showing Whisk's notifications — open Settings to fix it", "error");
  } catch {
    // A check that fails is not evidence of anything; stay quiet.
  }
}

/** The sender a per-thread rule would apply to. */
export function threadSender(t: Thread): string | null {
  return counterparty(t, mailStore.getState().accounts[t.account_id])?.email ?? null;
}
