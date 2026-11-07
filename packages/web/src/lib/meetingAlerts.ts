import type { CalendarEvent } from "@mail/shared/src/lib/calendarTypes";
import {
  meetingContent,
  meetingKey,
  shouldAlertMeeting,
} from "@mail/shared/src/lib/meetingAlerts";
import { mailStore } from "../store/mailStore";
import { notificationPrefs } from "./notifications";
import { desktopBridge } from "./desktopBridge";

const claimed = new Set<string>();
let reported = false;

export function openMeeting(event: CalendarEvent) {
  const state = mailStore.getState();
  state.closeThread();
  state.setView("calendar");
  state.setCalendarState({ calendarOpenId: event._id });
}

export async function alertMeeting(event: CalendarEvent): Promise<void> {
  const key = `whisk:meeting:${encodeURIComponent(meetingKey(event))}`;
  if (claimed.has(key)) return;
  const post = async () => {
    const prefs = notificationPrefs();
    const now = Date.now();
    if (!shouldAlertMeeting(event, prefs, now, document.hasFocus())) return;
    const bridge = desktopBridge();
    if (
      !bridge &&
      (typeof Notification === "undefined" ||
        Notification.permission !== "granted")
    )
      return;
    if (Number(localStorage.getItem(key)) > now) {
      claimed.add(key);
      return;
    }
    const { title, body } = meetingContent(event, prefs, now);
    if (bridge) {
      const result = await bridge.showNotification(title, body, {
        route: "/#calendar",
        key,
        kind: "calendar",
        silent: !prefs.sound,
        force: prefs.whenFocused,
      });
      if (!result.shown) return;
    } else {
      const notification = new Notification(title, {
        body,
        tag: key,
        silent: !prefs.sound,
      });
      notification.onclick = () => {
        window.focus();
        openMeeting(event);
        notification.close();
      };
    }
    claimed.add(key);
    localStorage.setItem(key, String(event.end));
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const item = localStorage.key(index);
      if (
        item?.startsWith("whisk:meeting:") &&
        Number(localStorage.getItem(item)) <= now
      )
        localStorage.removeItem(item);
    }
  };
  await (
    navigator.locks
      ? navigator.locks.request(key, post)
      : Promise.resolve().then(post)
  ).catch((error) => {
    if (reported) return;
    reported = true;
    console.error("Meeting reminder unavailable", error);
    mailStore
      .getState()
      .pushToast(
        "System reminders aren’t available. Upcoming events are still shown in Whisk.",
        "error",
      );
  });
}
