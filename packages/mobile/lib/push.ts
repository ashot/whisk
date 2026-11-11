// New mail and meetings reach the phone here. The server decides what is
// worth a push (the same rules as the desktop); this file registers the
// phone, shows the banner unless the thread is already on screen, fetches the
// mail a push names as soon as it hears of it, opens that thread on a tap (or
// joins the meeting a meeting push names), and keeps the icon badge equal to
// the inbox the person set.
import { useEffect, useState } from "react";
import { AppState, Linking, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { router, useNavigationContainerRef } from "expo-router";
import { api } from "@mail/convex/convex/_generated/api";
import { mailStore } from "@mail/shared/src/store/mailStore";
import { badgeCount, normalizePrefs } from "@mail/shared/src/lib/notifications";
import type { Thread } from "@mail/shared/src/store/types";
import { convexClient } from "./convex";
import { refreshSync } from "./auth";
import { openThreadScreen } from "./openThread";
import { loadThreadMessages, nameThread, storedToken } from "./sync";

export type MailPush = { kind?: string; thread_id?: string; thread_gmail_id?: string; account_id?: string; join?: string };
const dataOf = (n: Notifications.Notification): MailPush => (n.request.content.data ?? {}) as MailPush;

/** The mail a background push names. iOS hands the task the raw APNs
 *  payload, where Expo puts the data under `body`; Android hands the same
 *  data as a JSON string. A tap (a response) carries a notification. */
export function backgroundPushData(payload: Notifications.NotificationTaskPayload): MailPush {
  if ("notification" in payload && payload.notification && "request" in payload.notification) return dataOf(payload.notification as Notifications.Notification);
  const data = (payload as { data?: { body?: unknown; dataString?: string } }).data ?? {};
  if (data.body && typeof data.body === "object") return data.body as MailPush;
  if (typeof data.dataString === "string") {
    try {
      return JSON.parse(data.dataString) as MailPush;
    } catch {}
  }
  return {};
}

Notifications.setNotificationHandler({
  // Foreground: banner and sound, except for the thread already on screen,
  // where the message itself is the notification.
  handleNotification: async (n) => {
    const data = dataOf(n);
    const onScreen = !!data.thread_id && mailStore.getState().openThreadId === data.thread_id;
    return { shouldShowBanner: !onScreen, shouldShowList: !onScreen, shouldPlaySound: !onScreen, shouldSetBadge: false };
  },
});

let registered: string | null = null;

/** Ask for permission and hand this phone's token to the server. Runs on
 *  every launch while signed in; a token that did not change is cheap to
 *  send again, and a phone that changed hands moves to its new owner. */
function easProjectId(): string | undefined {
  return Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
}

async function register(authToken: string): Promise<void> {
  if (!Device.isDevice) return; // the simulator has no push token
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("mail", { name: "New mail", importance: Notifications.AndroidImportance.HIGH });
    // A meeting about to start is the one thing worth the loudest slot.
    await Notifications.setNotificationChannelAsync("meetings", {
      name: "Meetings",
      importance: Notifications.AndroidImportance.MAX,
      sound: "meeting-push.wav",
      vibrationPattern: [0, 250, 120, 250],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") ({ status } = await Notifications.requestPermissionsAsync());
  if (status !== "granted") return;
  const projectId = easProjectId();
  const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
  await convexClient().mutation(api.devices.registerPush, {
    token: authToken,
    push_token: token,
    platform: Platform.OS === "android" ? "android" : "ios",
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  registered = token;
}

/** Settings "Send a test": one banner, no new mail required. */
export async function sendTestPush(authToken: string): Promise<{ sent: number; reason?: string }> {
  await register(authToken);
  return convexClient().action(api.push.sendTest, { token: authToken });
}

/** Sign out: this phone stops hearing about that mailbox. Best effort. */
export async function forgetPush(authToken: string): Promise<void> {
  const token = registered;
  registered = null;
  if (!token) return;
  await convexClient().mutation(api.devices.unregisterPush, { token: authToken, push_token: token }).catch(() => {});
}

/** The local row a push is about. The row id the server sent is the key
 *  unless the row was rebuilt since the push was sent; the Gmail id holds. */
function localThreadId(data: MailPush): string | undefined {
  const { threads } = mailStore.getState();
  if (!data.thread_id || threads[data.thread_id]) return data.thread_id;
  const row = (Object.values(threads) as Thread[]).find((t) => t.gmail_id === data.thread_gmail_id && t.account_id === data.account_id);
  return row?._id ?? data.thread_id;
}

const hydrated = (): Promise<void> =>
  new Promise((resolve) => {
    if (mailStore.getState().hydrated) return resolve();
    const stop = (mailStore as any).subscribe((s: any) => {
      if (!s.hydrated) return;
      stop();
      resolve();
    });
  });

const warming = new Map<string, Promise<void>>();

/** Bring the mail a push names into the local cache: its thread row and its
 *  messages. Runs when the push arrives with the app open, and again at the
 *  tap, so the thread screen renders from the cache. Both reads leave at
 *  once, on a killed app too: they need only the stored login, and their
 *  answers wait for the cache to hydrate so it cannot overwrite them. */
export function warm(data: MailPush): Promise<void> {
  const { thread_id: id, thread_gmail_id: gmail_id, account_id } = data;
  if (!id || !gmail_id) return Promise.resolve();
  const running = warming.get(id);
  if (running) return running;
  const target = { gmail_id, account_id };
  nameThread(id, target);
  const run = (async () => {
    const token = mailStore.getState().authToken ?? (await storedToken());
    if (!token) return;
    const ready = hydrated();
    const [rows] = await Promise.all([
      convexClient().query(api.sync.threadsByIds, { token, gmailIds: [gmail_id] }),
      loadThreadMessages(token, target, ready),
      ready,
    ]);
    const openedAhead = !mailStore.getState().threads[localThreadId(data)!];
    mailStore.getState().syncTable("threads", rows);
    // A thread opened ahead of its row could not be marked read, and may
    // have been opened under a stale row id. Open it again now it is here.
    const st = mailStore.getState();
    if (openedAhead && st.openThreadId === id) st.openThread(localThreadId(data)!);
  })()
    .catch((e) => console.warn("[push] could not fetch the mail ahead of the open", e))
    .finally(() => warming.delete(id));
  warming.set(id, run);
  return run;
}

/** A tap: leave whatever was open and show the mail the push was about. */
export function open(data: MailPush): void {
  if (!mailStore.getState().authToken) return; // signed out: the welcome screen stays
  // A meeting push joins the meeting; with no link the app opening is enough.
  if (data.kind === "meeting") {
    if (data.join && /^https?:\/\//i.test(data.join)) void Linking.openURL(data.join);
    return;
  }
  if (router.canDismiss()) router.dismissAll();
  if (!data.thread_id) return; // a digest opens the inbox
  void warm(data);
  openThreadScreen(localThreadId(data)!);
  void refreshSync();
}

export function usePushNotifications(): void {
  const authToken = (mailStore as any)((s: any) => s.authToken) as string | null;

  useEffect(() => {
    if (!authToken) return;
    register(authToken).catch((e) => console.warn("[push] registration failed", e));
    // Turning notifications on in iOS Settings after the first launch used
    // to never send a token — this effect only ran when the auth token
    // changed. Re-register on every foreground, and whenever Expo rotates
    // the token.
    const app = AppState.addEventListener("change", (next) => {
      if (next === "active") register(authToken).catch((e) => console.warn("[push] registration failed", e));
    });
    // The listener reports the native device token, which Expo cannot send
    // to; a rotation is the cue to fetch and register the Expo token again.
    const sub = Notifications.addPushTokenListener(() => {
      register(authToken).catch((e) => console.warn("[push] token update failed", e));
    });
    return () => {
      app.remove();
      sub.remove();
    };
  }, [authToken]);

  // A tap is held until it can be shown. On a killed app it arrives before
  // the navigator exists (the root layout renders nothing until the fonts
  // load) and before the cache has hydrated; navigating then throws, and
  // resolving the thread then finds an empty store.
  const [tapped, setTapped] = useState<MailPush | null>(null);
  const nav = useNavigationContainerRef();
  const cacheReady = (mailStore as any)((s: any) => s.hydrated) as boolean;

  useEffect(() => {
    // A tap on a killed app arrives as the launching response, and on some
    // launches through the live listener as well: one response, one open.
    let last: string | null = null;
    const take = (r: Notifications.NotificationResponse | null) => {
      if (!r || r.notification.request.identifier === last) return;
      last = r.notification.request.identifier;
      const data = dataOf(r.notification);
      void warm(data); // the fetch starts now, the screen follows
      setTapped(data);
      // Spent: a reload (an update applying) must not open it again.
      Notifications.clearLastNotificationResponse();
    };
    Notifications.getLastNotificationResponseAsync().then(take).catch(() => {});
    const taps = Notifications.addNotificationResponseReceivedListener(take);
    const arrivals = Notifications.addNotificationReceivedListener((n) => void warm(dataOf(n)));
    return () => {
      taps.remove();
      arrivals.remove();
    };
  }, []);

  useEffect(() => {
    if (!tapped || !cacheReady) return;
    let frame = 0;
    const show = () => {
      if (!nav.isReady()) {
        frame = requestAnimationFrame(show);
        return;
      }
      setTapped(null);
      open(tapped);
    };
    show();
    return () => cancelAnimationFrame(frame);
  }, [tapped, cacheReady, nav]);

  // The icon badge follows the local store, so it is right whenever the app
  // has run recently, and the push carries none it could get wrong.
  useEffect(() => {
    let last = -1;
    const apply = () => {
      const s = mailStore.getState() as any;
      const n = s.authToken ? badgeCount(Object.values(s.threads ?? {}) as Thread[], normalizePrefs(s.clientState?.notifications), s.clusters) : 0;
      if (n === last) return;
      last = n;
      Notifications.setBadgeCountAsync(n).catch(() => {});
    };
    apply();
    return (mailStore as any).subscribe(apply);
  }, []);
}
