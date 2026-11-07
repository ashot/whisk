import React, { useState } from "react";
import { useTracked, useMailStore } from "../store/mailStore";
import {
  inboxUnreadCount,
  inScope,
  laneCounts,
  liveReminders,
  ACCOUNT_INK,
  accountColor,
  orderedAccounts,
  topLevel,
} from "../store/selectors";
import { CATEGORIES } from "@mail/shared/src/lib/categories";
import { gmailAuthUrl, openGmailAuth } from "../sync/ConvexSync";
import { useLocalAuth } from "../sync/localAuth";
import { initials } from "../lib/format";
import { currentTheme, toggleTheme } from "../lib/theme";
import type { Account, Cluster, Label, ViewId } from "../store/types";
import { HintPair, KeyCap } from "./KeyCap";
import { TopicMenu } from "./TopicMenu";

type NavItem = { view: ViewId; name: string; keys?: string; count?: number };

/** How many topics the rail lists: the biggest few, since the inbox rows
 *  carry the whole list. */
const RAIL_TOPICS = 8;

/** The topics with inbox mail, biggest first: the parts of the person's
 *  life the inbox is about right now. The same set the inbox shows as
 *  sections. */
function railTopics(threads: Parameters<typeof topLevel>[0], clusters: Parameters<typeof topLevel>[1], scope: string) {
  return topLevel(threads, clusters, scope).filter((p) => !p.meta.cluster?.hidden && p.threads.length > 0).sort((a, b) => b.threads.length - a.threads.length).slice(0, RAIL_TOPICS);
}

function RailItem({ item, active }: { item: NavItem; active: boolean }): React.ReactElement {
  const setView = useMailStore((s) => s.setView);
  return (
    <button
      className={`rail-item${active ? " is-active" : ""}`}
      onClick={() => setView(item.view)}
      title={item.name}
      aria-label={`${item.name}${item.count ? `, ${item.count} unread` : ""}`}
      aria-current={active ? "page" : undefined}
      tabIndex={item.view === "calendar" || item.view === "inbox" ? 0 : -1}
    >
      {/* Stands in for the name once the rail collapses on narrow screens. */}
      <span className="rail-item-glyph" aria-hidden>
        {item.name.slice(0, 2)}
      </span>
      <span className="rail-item-name">{item.name}</span>
      {item.count ? <span className="rail-item-count">{item.count}</span> : null}
      {item.keys ? (
        <span className="rail-item-keys">
          <KeyCap spec={item.keys} />
        </span>
      ) : null}
    </button>
  );
}

/** The account switcher: unified view, one row per account, add. Renders only
 *  once there is something to switch between (or to add to). */
function AccountSwitcher({
  accounts,
  scope,
}: {
  accounts: Account[];
  scope: string;
}): React.ReactElement | null {
  const st = useMailStore.getState();
  // Legacy sessions attach with their token; a Convex Auth session attaches
  // through a server-minted ticket — either way the popup flow is the same.
  const signedIn = useLocalAuth();
  const canAdd = !!gmailAuthUrl(true) || (signedIn && !!gmailAuthUrl());
  if (accounts.length <= 1 && !canAdd) return null;

  return (
    <div className="rail-group rail-accounts">
      {accounts.length > 1 && (
        <button
          className={`rail-item${scope === "all" ? " is-active" : ""}`}
          onClick={() => st.setAccountScope("all")}
          title="All inboxes (g 0)"
          tabIndex={-1}
        >
          <span className="rail-acct-dot rail-acct-all" aria-hidden>
            ∞
          </span>
          <span className="rail-item-name">All inboxes</span>
          <span className="rail-item-keys">
            <KeyCap spec="g 0" />
          </span>
        </button>
      )}
      {accounts.map((a, i) => (
        <button
          key={a._id}
          className={`rail-item${scope === a._id ? " is-active" : ""}`}
          onClick={() => st.setAccountScope(a._id)}
          title={`${a.email}${i < 9 ? ` (g ${i + 1})` : ""}`}
          tabIndex={-1}
        >
          <span
            className="rail-acct-dot"
            style={{ ["--acct" as any]: accountColor(st.accounts, a._id), ["--acct-ink" as any]: ACCOUNT_INK }}
            aria-hidden
          >
            {initials({ name: a.name, email: a.email })}
          </span>
          <span className="rail-item-name rail-acct-email">{a.email}</span>
          {a.sync_status === "backfilling" || a.sync_status === "syncing" ? (
            <span className="spin" title="Syncing" />
          ) : accounts.length > 1 && i < 9 ? (
            <span className="rail-item-keys">
              <KeyCap spec={`g ${i + 1}`} />
            </span>
          ) : null}
        </button>
      ))}
      {canAdd && (
        <button
          className="rail-item rail-add-account"
          onClick={() => void openGmailAuth(true)}
          title="Connect another Gmail account"
          tabIndex={-1}
        >
          <span className="rail-acct-dot rail-acct-add" aria-hidden>
            +
          </span>
          <span className="rail-item-name">Add account</span>
        </button>
      )}
    </div>
  );
}

/** Opens the search bar and puts the caret in it. */
export function openSearch(): void {
  useMailStore.getState().setSearch(true);
  // The bar autofocuses when it mounts; when it is already open this click
  // took the focus, so hand it back.
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".searchbar-input")?.focus());
}

/** Search as a place in the rail, for the hand on the mouse: the same bar
 *  `/` opens, lit while it is open or its results are on screen. */
function SearchItem({ active }: { active: boolean }): React.ReactElement {
  return (
    <button
      className={`rail-item rail-search${active ? " is-active" : ""}`}
      type="button"
      tabIndex={-1}
      title="Search mail"
      aria-label="Search mail"
      onClick={openSearch}
    >
      <svg className="rail-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" aria-hidden>
        <circle cx="10.5" cy="10.5" r="6" />
        <path d="M15 15l5 5" />
      </svg>
      <span className="rail-item-name">Search</span>
      <span className="rail-search-key">
        <KeyCap spec="/" />
      </span>
    </button>
  );
}

/** Sun and moon both render; the CSS shows the one for the theme you would
 *  switch to and turns them past each other on the flip. */
function ThemeToggle(): React.ReactElement {
  const label = currentTheme() === "dark" ? "Switch to light" : "Switch to dark";
  return (
    <button
      className="rail-theme"
      type="button"
      tabIndex={-1}
      title={label}
      aria-label={label}
      onClick={(e) => toggleTheme(e.currentTarget)}
    >
      <svg className="rail-theme-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="3.6" />
        <path d="M12 3.2v1.6M12 19.2v1.6M3.2 12h1.6M19.2 12h1.6M5.8 5.8l1.1 1.1M17.1 17.1l1.1 1.1M5.8 18.2l1.1-1.1M17.1 6.9l1.1-1.1" />
      </svg>
      <svg className="rail-theme-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" aria-hidden>
        <path d="M19.5 14.6A7.6 7.6 0 0 1 9.4 4.5a7.6 7.6 0 1 0 10.1 10.1z" />
      </svg>
    </button>
  );
}

export function Rail(): React.ReactElement {
  const s = useTracked([
    (s) => s.activeView,
    (s) => s.accountScope,
    (s) => s.clientState?.theme,
    (s) => s.searchOpen,
    // The count itself, not the collection: the rail shows one number, so it
    // should wake for that number and not for every field on every thread.
    (s) => inboxUnreadCount(s.threads, s.accountScope, s.clusters),
    (s) => s.labels,
    (s) => s.drafts,
    (s) => s.accounts,
    // Deps compare by Object.is — serialize the lane tally so the rail wakes
    // only when a lane's numbers actually move, not on every thread touch.
    (s) => JSON.stringify([...laneCounts(s.threads, s.accountScope)]),
    // Pinned topics sit in the rail; wake only when their names or numbers move.
    (s) => JSON.stringify(railTopics(s.threads, s.clusters, s.accountScope).map((p) => [p.meta.id, p.meta.name, p.unread, p.threads.length])),
    (s) => s.reminders,
  ]);
  const topics = railTopics(s.threads, s.clusters, s.accountScope);
  const [topicMenu, setTopicMenu] = useState<{ cluster: Cluster; x: number; y: number } | null>(null);

  const accounts = orderedAccounts(s.accounts) as Account[];
  const primary = accounts[0];
  const inboxUnread = inboxUnreadCount(s.threads, s.accountScope, s.clusters);
  const draftCount = Object.values(s.drafts).filter((d) =>
    inScope(d, s.accountScope),
  ).length;

  // Reminder counts feed the Later/Waiting rows; the rows appear only while
  // something is actually parked there.
  const live = liveReminders(s.reminders);
  let laterCount = 0;
  let waitingCount = 0;
  for (const r of live.values()) {
    const account = s.accountScope === "all" || r.account_id === s.accountScope;
    if (!account) continue;
    if (r.kind === "snooze") laterCount++;
    else waitingCount++;
  }

  const primaryNav: NavItem[] = [
    { view: "inbox", name: "Inbox", keys: "g i", count: inboxUnread },
    { view: "calendar", name: "Calendar", keys: "g e" },
    { view: "sweep", name: "Sweep", keys: "g c" },
    { view: "starred", name: "Starred", keys: "g s" },
    ...(laterCount > 0
      ? [{ view: "later" as const, name: "Later", keys: "g z", count: laterCount }]
      : []),
    ...(waitingCount > 0
      ? [{ view: "waiting" as const, name: "Waiting", keys: "g w", count: waitingCount }]
      : []),
    { view: "drafts", name: "Drafts", keys: "g d", count: draftCount },
    { view: "sent", name: "Sent", keys: "g t" },
    { view: "archive", name: "Archive", keys: "g a" },
    { view: "trash", name: "Trash" },
    { view: "spam", name: "Spam" },
  ];

  const lanes = laneCounts(s.threads, s.accountScope);
  const laneItems = CATEGORIES.filter((c) => (lanes.get(c.id)?.total ?? 0) > 0);

  // User labels belong to one mailbox; the unified view keeps the rail to
  // system views and the per-account rails show their own labels.
  const userLabels =
    s.accountScope === "all" && accounts.length > 1
      ? []
      : (Object.values(s.labels) as Label[])
          .filter(
            (l) =>
              l.kind === "user" &&
              !l.deleted &&
              inScope(l, s.accountScope === "all" ? primary?._id : s.accountScope),
          )
          .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <nav className="rail">
      <div className="rail-brand">
        {/* U+FE0E pins the text presentation — bare ✉ renders as a colour
            emoji on some platforms and breaks the typeset look. */}
        <span className="rail-brand-mark" aria-hidden>
          {"✉︎"}
        </span>
        <span className="rail-brand-name">Whisk</span>
        <ThemeToggle />
      </div>

      <SearchItem active={s.searchOpen || s.activeView.startsWith("search:")} />

      <AccountSwitcher accounts={accounts} scope={s.accountScope} />

      <div className="rail-group">
        {primaryNav.map((item) => (
          <RailItem key={item.view} item={item} active={s.activeView === item.view} />
        ))}
      </div>

      {laneItems.length > 0 && (
        <div className="rail-group">
          <button
            className={`rail-heading rail-heading-link${s.activeView === "sweep" ? " is-active" : ""}`}
            onClick={() => useMailStore.getState().setView("sweep")}
            title="Sweep the inbox by lane"
            tabIndex={-1}
          >
            Lanes
            <span className="rail-item-keys">
              <KeyCap spec="g c" />
            </span>
          </button>
          {laneItems.map((c) => {
            const count = lanes.get(c.id)!;
            return (
              <button
                key={c.id}
                className={`rail-item${s.activeView === `cat:${c.id}` ? " is-active" : ""}`}
                onClick={() => useMailStore.getState().setView(`cat:${c.id}`)}
                title={c.hint}
                tabIndex={-1}
              >
                <span
                  className="cat-dot"
                  style={{ ["--hue" as any]: c.hue }}
                  aria-hidden
                />
                <span className="rail-item-name">{c.name}</span>
                <span className="rail-item-count rail-lane-count">
                  {count.unread > 0 ? count.unread : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {topics.length > 0 && (
        <div className="rail-group">
          <button
            className="rail-heading rail-heading-link"
            onClick={() => { useMailStore.getState().setInboxGrouped(true); useMailStore.getState().setView("inbox"); }}
            title="The inbox as topics (v)"
            tabIndex={-1}
          >
            Topics
            <span className="rail-item-keys">
              <KeyCap spec="v" />
            </span>
          </button>
          {topics.map((p) => (
            <button
              key={p.meta.id}
              className={`rail-item${s.activeView === p.meta.view ? " is-active" : ""}`}
              onClick={() => useMailStore.getState().setView(p.meta.view)}
              onContextMenu={p.meta.cluster ? (e) => { e.preventDefault(); e.stopPropagation(); setTopicMenu({ cluster: p.meta.cluster!, x: e.clientX, y: e.clientY }); } : undefined}
              title={`${p.meta.hint || p.meta.name}${s.accountScope === "all" && accounts.length > 1 ? ` · ${s.accounts[p.meta.cluster!.account_id]?.email ?? ""}` : ""}`}
              tabIndex={-1}
            >
              {s.accountScope === "all" && accounts.length > 1
                ? <span className="row-acct-dot rail-topic-acct" style={{ ["--acct" as any]: accountColor(s.accounts, p.meta.cluster!.account_id) }} aria-hidden />
                : <span className="cat-dot" style={{ ["--hue" as any]: p.meta.hue }} aria-hidden />}
              <span className="rail-item-name">{p.meta.name}</span>
              <span className="rail-item-count rail-lane-count">{p.unread > 0 ? p.unread : ""}</span>
            </button>
          ))}
          {topicMenu && <TopicMenu cluster={topicMenu.cluster} x={topicMenu.x} y={topicMenu.y} onClose={() => setTopicMenu(null)} />}
        </div>
      )}

      {userLabels.length > 0 && (
        <div className="rail-group">
          <div className="rail-heading">Labels</div>
          {userLabels.map((l) => (
            <button
              key={l._id}
              className={`rail-item${s.activeView === `label:${l.gmail_id}` ? " is-active" : ""}`}
              onClick={() => useMailStore.getState().setView(`label:${l.gmail_id}`)}
              title={l.name}
              tabIndex={-1}
            >
              <span className="rail-label-dot" style={{ background: l.color?.bg }} aria-hidden />
              <span className="rail-item-name">{l.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="rail-foot">
        {primary?.provider === "demo" && (
          <div className="rail-demo-note">
            Demo mailbox
            <span className="rail-demo-sub">nothing here is real</span>
          </div>
        )}
        {accounts.length === 1 && (
          <div className="rail-account" title={primary?.email}>
            {primary?.email}
          </div>
        )}
        <div className="rail-hint">
          <HintPair spec="?">shortcuts</HintPair>
          <button
            className="rail-hint-link"
            onClick={() => useMailStore.getState().setSettings(true)}
            tabIndex={-1}
          >
            <HintPair spec="mod+,">settings</HintPair>
          </button>
        </div>
      </div>
    </nav>
  );
}
