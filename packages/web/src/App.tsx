import { MeetingAlerts } from "./components/MeetingAlerts";
import { Calendar } from "./components/Calendar";
import { CalendarSync } from "./sync/CalendarSync";
import React from "react";
import { useMailStore, useTracked } from "./store/mailStore";
import { Rail } from "./components/Rail";
import { ThreadList } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";
import { Compose } from "./components/Compose";
import { ComposeDrop } from "./components/ComposeDrop";
import { AttachmentViewer } from "./components/Attachments";
import { Palette } from "./components/Palette";
import { HelpOverlay } from "./components/HelpOverlay";
import { LabelPicker } from "./components/LabelPicker";
import { CategoryPicker } from "./components/CategoryPicker";
import { TimePicker } from "./components/TimePicker";
import { Memories } from "./components/Memories";
import { Settings } from "./components/Settings";
import { Sweep } from "./components/Sweep";
import { Filters } from "./components/Filters";
import { ClusterPicker } from "./components/ClusterPicker";
import { Toasts } from "./components/Toasts";
import { Welcome } from "./components/Welcome";
import { CliConnect, useCliConnect } from "./components/CliConnect";
import { AppConnect, useAppConnect } from "./components/AppConnect";
import { PendingKeys } from "./components/PendingKeys";
import { SearchBar } from "./components/SearchBar";
import { ConvexSync } from "./sync/ConvexSync";
import { useHashRouter } from "./sync/hashRouter";
import { ComposeFab } from "./components/MobileNav";
import { isCalendarWindow } from "./lib/calendarWindow";
import "./design/calendar-window.css";
// Last, so the phone layout overrides every component sheet above it.
import "./design/mobile.css";

export function App(): React.ReactElement {
  const s = useTracked([
    (s) => Object.keys(s.accounts).length,
    (s) => s.authToken,
    (s) => s.openThreadId,
    (s) => s.openThreadId !== null && s.openThreadId === s.soloThreadId,
    (s) => s.paletteOpen,
    (s) => s.helpOpen,
    (s) => s.labelPickerOpen,
    (s) => s.categoryPickerOpen,
    (s) => s.timePicker,
    (s) => s.memoriesOpen,
    (s) => s.settingsOpen,
    (s) => s.filtersOpen,
    (s) => s.clusterPickerOpen,
    (s) => s.searchOpen,
    (s) => s.activeView === "sweep",
    (s) => s.activeView === "calendar",
    (s) => s.hydrated,
    (s) => s.navOpen,
  ]);
  useHashRouter();
  // `whisk auth` lands here with a connect request; it is served once the
  // roster is in (a signed-out visitor sees Welcome first, and the request
  // survives the sign-in round trip).
  const [cliRequest, cliDone] = useCliConnect();
  // Another app (codecast) sends the person to /connect the same way.
  const [appRequest, appDone] = useAppConnect();
  const solo = s.openThreadId !== null && s.openThreadId === s.soloThreadId;
  // The desktop calendar window is the calendar alone (lib/calendarWindow).
  const calendarOnly = isCalendarWindow;

  // ConvexSync stays the FIRST child in a stable Fragment across every branch,
  // so hydration/auth transitions never remount it (a remount would tear down
  // persistence wiring and every live subscription). Pre-hydration we paint
  // only the background — flashing an empty inbox or the welcome screen at a
  // returning user reads worse than a beat of quiet (IDB replay is <100ms).
  return (
    <>
      <ConvexSync />
      <CalendarSync />
      {/* A token with an empty roster is a cold cache, not a signed-out user —
          keep painting quiet until the session envelope lands. */}
      {Object.keys(s.accounts).length === 0 && (!s.hydrated || s.authToken) ? null : appRequest ? (
        // Signed out too: the connect card carries the sign-in itself.
        <AppConnect request={appRequest} onDone={appDone} />
      ) : Object.keys(s.accounts).length === 0 ? (
        <Welcome />
      ) : cliRequest ? (
        <CliConnect request={cliRequest} onDone={cliDone} />
      ) : (
        <>
          {/* A linked thread is a page of its own: the rail stays out until
              the person leaves the thread, then the app is there behind it. */}
          <div className={`shell${solo || calendarOnly ? " shell-solo" : ""}${calendarOnly ? " shell-calendar" : ""}${s.navOpen ? " is-nav-open" : ""}`}>
            {!solo && !calendarOnly && <Rail />}
            {/* On a phone the rail is a drawer; the scrim behind it closes it. */}
            {s.navOpen && <div className="nav-scrim" onClick={() => useMailStore.getState().setNav(false)} aria-hidden />}
            <main className="main">
              {s.searchOpen && <SearchBar />}
              {s.openThreadId && !calendarOnly ? (
                <ThreadView key={s.openThreadId} />
              ) : s.activeView === "calendar" || calendarOnly ? (
                <Calendar />
              ) : s.activeView === "sweep" ? (
                <Sweep />
              ) : (
                <ThreadList />
              )}
              {!s.openThreadId && s.activeView !== "calendar" && !calendarOnly && <ComposeFab />}
            </main>
          </div>
          <MeetingAlerts />
          <ComposeDrop />
          <Compose />
          <AttachmentViewer />
          {s.labelPickerOpen && <LabelPicker />}
          {s.categoryPickerOpen && <CategoryPicker />}
          {s.timePicker && <TimePicker />}
          {s.memoriesOpen && <Memories />}
          {s.settingsOpen && <Settings />}
          {s.filtersOpen && <Filters />}
          {s.clusterPickerOpen && <ClusterPicker />}
          {s.paletteOpen && <Palette />}
          {s.helpOpen && <HelpOverlay />}
        </>
      )}
      <Toasts />
      <PendingKeys />
    </>
  );
}
