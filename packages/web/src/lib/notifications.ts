// Reading and writing the notification rules. The rules themselves live in
// client prefs, so they follow the person to every device they use Whisk on;
// the decisions they drive live in @mail/shared/src/lib/notifications.
import { useMailStore, useTracked } from "../store/mailStore";
import { desktopBridge } from "./desktopBridge";
import {
  DEFAULT_NOTIFICATION_PREFS,
  normalizeMatcher,
  normalizePrefs,
  type NotificationPrefs,
  type OsNotifyState,
} from "@mail/shared/src/lib/notifications";

export * from "@mail/shared/src/lib/notifications";

export function notificationPrefs(): NotificationPrefs {
  return normalizePrefs(useMailStore.getState().clientState?.notifications);
}

/** Subscribe a component to the rules. */
export function useNotificationPrefs(): NotificationPrefs {
  const s = useTracked([(s) => s.clientState?.notifications]);
  return normalizePrefs(s.clientState?.notifications);
}

/** Write a change. The whole object is stored, so a device running an older
 *  build never silently drops a key it does not know about. */
export function setNotificationPrefs(
  update: Partial<NotificationPrefs> | ((cur: NotificationPrefs) => NotificationPrefs),
): NotificationPrefs {
  const cur = notificationPrefs();
  const next = normalizePrefs(typeof update === "function" ? update(cur) : { ...cur, ...update });
  useMailStore.getState().setClientPref("notifications", next);
  return next;
}

const without = (list: string[], entry: string) => list.filter((e) => e !== entry);

/** Move a sender on or off a list, keeping the two lists exclusive: nobody is
 *  both the person you always want and the person you never do. */
export function setSenderRule(email: string, rule: "vip" | "muted" | "none"): NotificationPrefs {
  const entry = normalizeMatcher(email);
  if (!entry) return notificationPrefs();
  return setNotificationPrefs((p) => ({
    ...p,
    vips: rule === "vip" ? [...without(p.vips, entry), entry] : without(p.vips, entry),
    muted: rule === "muted" ? [...without(p.muted, entry), entry] : without(p.muted, entry),
  }));
}

export function senderRule(email: string, p: NotificationPrefs): "vip" | "muted" | "none" {
  const entry = normalizeMatcher(email);
  if (p.vips.includes(entry)) return "vip";
  if (p.muted.includes(entry)) return "muted";
  return "none";
}

export { DEFAULT_NOTIFICATION_PREFS };

// ——— what the OS has to say about it ———
//
// Two different questions, and only one of them has an honest answer in a
// browser. A browser reports whether the page may post a notification; the
// desktop shell can go further and report whether the system actually drew
// the last one, which is the question someone who "sees no notifications" is
// really asking.

/** Read the state without disturbing anyone. `refresh` re-reads the OS on
 *  desktop (a few seconds, posts nothing). */
export async function osNotifyState(opts: { refresh?: boolean } = {}): Promise<OsNotifyState> {
  const bridge = desktopBridge();
  if (bridge?.getNotificationStatus) {
    try {
      const s = await bridge.getNotificationStatus({ refresh: opts.refresh === true });
      return (s?.status ?? "unknown") as OsNotifyState;
    } catch {
      return "unknown";
    }
  }
  if (typeof Notification === "undefined") return "unsupported";
  const p = Notification.permission;
  return p === "granted" ? "granted" : p === "denied" ? "denied" : "prompt";
}

/** Ask the browser for permission. The desktop shell has no equivalent: macOS
 *  decides at the first notification and afterwards only its settings pane
 *  can change the answer, which is what openOsNotificationSettings is for. */
export async function askNotificationPermission(): Promise<OsNotifyState> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    const p = await Notification.requestPermission();
    return p === "granted" ? "granted" : p === "denied" ? "denied" : "prompt";
  } catch {
    return osNotifyState();
  }
}

/** Open the system's notification settings for this app. */
export function openOsNotificationSettings(): boolean {
  const bridge = desktopBridge();
  if (!bridge?.openNotificationSettings) return false;
  void bridge.openNotificationSettings();
  return true;
}
