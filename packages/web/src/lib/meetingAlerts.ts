import type { CalendarEvent } from "@mail/shared/src/lib/calendarTypes";
import { calendarKey, safeCalendarUrl } from "@mail/shared/src/lib/calendar";
import {
  meetingContent,
  meetingKey,
  meetingStage,
  shouldAlertMeeting,
  type MeetingStage,
} from "@mail/shared/src/lib/meetingAlerts";
import soonSound from "@mail/shared/assets/sounds/meeting-soon.wav?url";
import nowSound from "@mail/shared/assets/sounds/meeting-now.wav?url";
import { mailStore } from "../store/mailStore";
import { notificationPrefs } from "./notifications";
import { desktopBridge } from "./desktopBridge";

// A meeting alerts twice (shared/lib/meetingAlerts): "soon" as it enters the
// lead window, "now" as it starts. Each stage is claimed once across every
// window and tab (a Web Lock plus a localStorage mark that lives until the
// meeting ends), then shown:
// - in the desktop app, as the shell's meeting panel: a card floating over
//   every app and Space with the meeting's sound, until it is joined or
//   dismissed (packages/desktop/main.js, "meeting-alert");
// - in a browser, as a system notification when the page is in the
//   background, with the meeting's sound played here either way, beside the
//   in-app card (components/MeetingAlerts).

const claimed = new Set<string>();
let reported = false;

const SOUNDS: Record<MeetingStage, string> = { soon: soonSound, now: nowSound };

/** The meeting's sound, at full volume. A browser that has not seen a click
 *  on the page yet may refuse; the card and the notification still show. */
export function playMeetingSound(stage: MeetingStage): void {
  const audio = new Audio(SOUNDS[stage]);
  void audio.play().catch(() => {});
}

export function openMeeting(event: CalendarEvent) {
  const state = mailStore.getState();
  state.closeThread();
  state.setView("calendar");
  state.setCalendarState({ calendarOpenId: event._id });
}

/** What the desktop panel draws for one meeting stage. */
export type MeetingAlertPayload = {
  key: string;
  stage: MeetingStage;
  eventId: string;
  title: string;
  start: number;
  end: number;
  join: string | null;
  where: string | null;
  color: string | null;
  sound: boolean;
};

function panelPayload(event: CalendarEvent, stage: MeetingStage, now: number): MeetingAlertPayload {
  const prefs = notificationPrefs();
  const { title } = meetingContent(event, prefs, now);
  const calendar = Object.values(mailStore.getState().calendars).find(
    (c) => calendarKey(c.account_id, c.google_id) === calendarKey(event.account_id, event.calendar_google_id),
  );
  const full = prefs.preview === "full";
  return {
    key: meetingKey(event),
    stage,
    eventId: event._id,
    title,
    start: event.start,
    end: event.end,
    join: safeCalendarUrl(event.conference_url),
    where: full ? event.location?.trim() || calendar?.summary || null : null,
    color: calendar?.color ?? null,
    sound: prefs.sound,
  };
}

/** Post one stage through the desktop panel. False on a shell from before
 *  the panel, which then gets the plain banner. */
async function showPanel(payload: MeetingAlertPayload): Promise<boolean> {
  const bridge = desktopBridge();
  if (!bridge) return false;
  try {
    await bridge.call("meeting-alert", payload);
    return true;
  } catch {
    return false;
  }
}

export async function alertMeeting(event: CalendarEvent): Promise<void> {
  const stage = meetingStage(event, Date.now());
  if (!stage) return;
  const key = `whisk:meeting:${encodeURIComponent(meetingKey(event))}:${stage}`;
  if (claimed.has(key)) return;
  const post = async () => {
    const prefs = notificationPrefs();
    const now = Date.now();
    // Whether this stage alerts at all ignores focus: the desktop panel is
    // meant to be seen whatever is in front, and a focused tab still plays
    // the sound beside its in-app card. Focus only decides whether a browser
    // also posts a system notification.
    if (!shouldAlertMeeting(event, prefs, now, false)) return;
    if (Number(localStorage.getItem(key)) > now) {
      claimed.add(key);
      return;
    }
    const bridge = desktopBridge();
    if (bridge) {
      if (!(await showPanel(panelPayload(event, stage, now)))) {
        const { title, body } = meetingContent(event, prefs, now);
        const result = await bridge.showNotification(title, body, {
          route: "/#calendar",
          key,
          kind: "calendar",
          silent: !prefs.sound,
          force: true,
        });
        if (!result.shown) return;
      }
    } else {
      const background = !document.hasFocus() || prefs.whenFocused;
      if (background && typeof Notification !== "undefined" && Notification.permission === "granted") {
        const { title, body } = meetingContent(event, prefs, now);
        // Silent: the meeting's own sound plays below instead of the system's.
        const notification = new Notification(title, { body, tag: key, silent: true, requireInteraction: stage === "now" });
        notification.onclick = () => {
          window.focus();
          openMeeting(event);
          notification.close();
        };
      }
      if (prefs.sound) playMeetingSound(stage);
    }
    claim(key, event, now);
  };
  await (navigator.locks ? navigator.locks.request(key, post) : Promise.resolve().then(post)).catch((error) => {
    if (reported) return;
    reported = true;
    console.error("Meeting reminder unavailable", error);
    mailStore.getState().pushToast("System reminders aren’t available. Upcoming events are still shown in Whisk.", "error");
  });
}

function claim(key: string, event: CalendarEvent, now: number): void {
  claimed.add(key);
  localStorage.setItem(key, String(event.end));
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const item = localStorage.key(index);
    if (item?.startsWith("whisk:meeting:") && Number(localStorage.getItem(item)) <= now) localStorage.removeItem(item);
  }
}
