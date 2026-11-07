import React from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import { inboxLenses, inboxUnreadCount, isInboxList } from "../store/selectors";
import { runKey } from "../keys/bindings";
import { openSearch } from "./Rail";

/** The phone's way into the rail: it opens the rail as a drawer. Hidden
 *  wherever the rail is on screen. The dot says the inbox has unread mail
 *  while you are somewhere else. */
export function NavButton(): React.ReactElement {
  const s = useTracked([
    (s) => s.activeView,
    (s) => inboxUnreadCount(s.threads, s.accountScope, s.clusters, inboxLenses(s)) > 0,
  ]);
  const dot = !isInboxList(s.activeView) && inboxUnreadCount(s.threads, s.accountScope, s.clusters, inboxLenses(s)) > 0;
  return (
    <button className="nav-btn mobile-only" type="button" aria-label="Open navigation" onClick={() => useMailStore.getState().setNav(true)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
        <path d="M4 7h16M4 12h16M4 17h10" />
      </svg>
      {dot && <span className="nav-btn-dot" aria-hidden />}
    </button>
  );
}

export function SearchButton(): React.ReactElement {
  return (
    <button className="nav-btn nav-btn-search mobile-only" type="button" aria-label="Search mail" onClick={openSearch}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
        <circle cx="10.5" cy="10.5" r="6" />
        <path d="M15 15l5 5" />
      </svg>
    </button>
  );
}

/** New message, for a thumb: the same action as `c`. */
export function ComposeFab(): React.ReactElement {
  return (
    <button className="compose-fab mobile-only" type="button" aria-label="New message" onClick={() => runKey("c")}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 20h8" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    </button>
  );
}

const ICONS: Record<string, React.ReactNode> = {
  e: (
    <>
      <rect x="3.5" y="4.5" width="17" height="4" rx="1" />
      <path d="M5 8.5v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-10M10 12.5h4" />
    </>
  ),
  "#": <path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13M10.5 10.5v5.5M13.5 10.5v5.5" />,
  z: (
    <>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9v4l2.5 2M4.5 4.5l-1.5 1.5M19.5 4.5 21 6" />
    </>
  ),
  U: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  s: <path d="m12 3.8 2.5 5.2 5.6.8-4.1 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.8Z" />,
};

const THREAD_ACTIONS: [key: string, label: string][] = [
  ["s", "Star"],
  ["z", "Snooze"],
  ["U", "Mark unread"],
  ["#", "Trash"],
  ["e", "Archive"],
];

/** A thread's verbs for a thumb, each the same binding as its key. */
export function ThreadActions({ starred }: { starred: boolean }): React.ReactElement {
  return (
    <div className="thread-actions mobile-only">
      {THREAD_ACTIONS.map(([key, label]) => (
        <button
          key={key}
          type="button"
          className={`thread-action${key === "s" && starred ? " is-on" : ""}`}
          aria-label={key === "s" && starred ? "Unstar" : label}
          onClick={() => runKey(key)}
        >
          <svg viewBox="0 0 24 24" fill={key === "s" && starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {ICONS[key]}
          </svg>
        </button>
      ))}
    </div>
  );
}
