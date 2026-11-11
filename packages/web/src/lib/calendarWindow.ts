import { mailStore } from "../store/mailStore";
import { desktopBridge } from "./desktopBridge";
import { threadHash } from "../sync/hashRouter";

// In the desktop app the calendar is a window of its own. The main window
// never shows it: going to the calendar there (the rail, `g e`, the palette,
// a meeting alert) brings the calendar window forward instead. The calendar
// window shows only the calendar: going anywhere else from it (`g i`, the
// invitation's email) happens in the main window. In a browser, and on a
// phone, the calendar stays a view like any other.
//
// The shell opens the window as a detached tab window on /#calendar, keyed so
// a second ask focuses it (packages/desktop/main.js, "calendar-window").

const bridge = desktopBridge();

/** This renderer is the desktop calendar window. Read once at boot: the
 *  window opened on #calendar is the calendar window for its whole life. */
export const isCalendarWindow = !!bridge?.isTabWindow && /^#calendar(?:$|[/?])/.test(location.hash);

/** The main desktop window, whose calendar lives in the other window. */
const isMainWindow = !!bridge && !bridge.isTabWindow;

export function openCalendarWindow(eventId?: string | null): void {
  void bridge?.call("calendar-window", eventId ?? null);
}

function showInMain(hash: string): void {
  void bridge?.call("main-window", `/${hash}`);
}

function whenHydrated(run: () => void): void {
  if (mailStore.getState().hydrated) return run();
  const stop = mailStore.subscribe((s) => {
    if (!s.hydrated) return;
    stop();
    run();
  });
}

export function attachCalendarWindow(): void {
  if (isMainWindow) {
    mailStore.subscribe((s, prev) => {
      if (s.activeView !== "calendar" || prev.activeView === "calendar") return;
      // Back to where the person was; the event to open (a meeting alert
      // sets it right after the view) is read once this change settles.
      s.setView(prev.activeView);
      queueMicrotask(() => {
        const st = mailStore.getState();
        openCalendarWindow(st.calendarOpenId);
        if (st.calendarOpenId) st.setCalendarState({ calendarOpenId: null });
      });
    });
    return;
  }
  if (!isCalendarWindow || !bridge) return;

  const open = (id: unknown) => {
    if (typeof id !== "string" || !id) return;
    whenHydrated(() => mailStore.getState().setCalendarState({ calendarOpenId: id }));
  };
  open(new URLSearchParams(location.search).get("event"));
  bridge.subscribe("calendar-open", open);

  mailStore.subscribe((s, prev) => {
    if (s.openThreadId && s.openThreadId !== prev.openThreadId) {
      const thread = s.threads[s.openThreadId];
      s.closeThread();
      if (thread) showInMain(threadHash(thread.gmail_id));
      return;
    }
    if (s.activeView !== "calendar" && prev.activeView === "calendar") {
      const view = s.activeView;
      s.setView("calendar");
      showInMain(view === "inbox" ? "#inbox" : `#${encodeURIComponent(view)}`);
    }
  });
}
