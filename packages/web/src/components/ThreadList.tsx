import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMailStore, useTracked } from "../store/mailStore";
import {
  inboxGrouping,
  inboxItems,
  shownTopic,
  topicPile,
  loosePile,
  viewRoot,
  inScope,
  liveReminders,
  accountColor,
  orderedAccounts,
  reminderFor,
  visibleThreads,
  viewTitle,
  isInboxList,
  viewSlice,
  inboxLenses,
  privacyRules,
  viewLensId,
  ALL_INBOX,
  LOOSE_SECTION,
  type InboxItem,
} from "../store/selectors";
import { SectionRow, MoreRow, MutedFoot, GroupToggle, GroupingProgress, type Mailbox } from "./TopicRows";
import type { Account, Cluster, Label, Reminder, Thread } from "../store/types";
import { participantsLine, relativeDate } from "../lib/format";
import { categoryMeta } from "@mail/shared/src/lib/categories";
import { dueLabel } from "@mail/shared/src/lib/times";
import type { Sender } from "@mail/shared/src/lib/sendAs";
import { useCoarseNow } from "@mail/platform";
import { threadPrivacy } from "@mail/shared/src/lib/privacy";
import { HintPair } from "./KeyCap";
import { DraftList } from "./DraftList";
import { LensMenuItems, LensPanel, LensTabs, startMailDrag } from "./Lenses";
import { PopMenu } from "./PopMenu";

/** What a gesture on a row reaches: the selection when the row is in it,
 *  else the row alone. */
function rowGesture(t: Thread): string[] {
  const selected = Object.keys(useMailStore.getState().selected);
  return selected.includes(t._id) ? selected : [t._id];
}
import { TopicHead } from "./TopicHead";
import { NavButton, SearchButton } from "./MobileNav";
import { useNarrow } from "../lib/narrow";
import { useSwipe } from "../lib/swipe";

function LockIcon(): React.ReactElement {
  return (
    <svg className="row-clip" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.4" role="img" aria-label="Private: hidden from agents">
      <title>Private: hidden from agents</title>
      <rect x="3" y="7" width="10" height="7.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

/** Drawn, not typed: a text glyph (⊕, 📎) is at the mercy of the platform's
 *  emoji substitution and lands in the wrong face and weight. */
function ClipIcon(): React.ReactElement {
  return (
    <svg
      className="row-clip"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Has attachment"
    >
      <path d="M13 6.2 7.1 12a2.9 2.9 0 0 1-4.1-4.1l6.4-6.4a1.95 1.95 0 0 1 2.8 2.8L5.8 10.7a1 1 0 0 1-1.4-1.4l5.7-5.7" />
    </svg>
  );
}

const EMPTY_LINES: Record<string, [string, string]> = {
  inbox: ["Nothing important.", "The rest is under Other. Press i to look."],
  lens: ["Nothing in this view.", "Slide toward More in its panel to widen it."],
  other: ["Nothing else.", "Everything in the inbox is marked important."],
  starred: ["No stars.", "Press s on anything worth keeping close."],
  sent: ["Nothing sent yet.", "Press c to write your first."],
  archive: ["Archive is empty.", "e files things away — gone but not forgotten."],
  trash: ["Trash is empty.", "Nothing rots here."],
  spam: ["No spam.", "The filters are eating well."],
  search: ["No matches.", "Try fewer words."],
  label: ["Nothing under this label.", "Press l on a conversation to file it here."],
  cat: ["This lane is clear.", "Press m on a conversation to file it here."],
  later: ["Nothing snoozed.", "Press z to park a conversation until later."],
  waiting: ["Not waiting on anyone.", "Press F after you send to watch for the reply."],
  cluster: ["This topic is clear.", "New conversations that belong here join it as they arrive."],
  [`cluster:${LOOSE_SECTION}`]: ["Everything has a topic.", "Whisk found a place for every conversation in the inbox."],
};

function EmptyState({ view }: { view: string }): React.ReactElement {
  const key = view.startsWith("search:")
    ? "search"
    : view.startsWith("label:")
      ? "label"
      : view.startsWith("cat:")
        ? "cat"
        : view.startsWith("lens:")
          ? "lens"
        : view.startsWith("cluster:") && view !== `cluster:${LOOSE_SECTION}`
          ? "cluster"
          : view;
  const [title, sub] = EMPTY_LINES[key] ?? ["Nothing here.", ""];
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      <div className="empty-sub">{sub}</div>
    </div>
  );
}

const ThreadRow = React.memo(function ThreadRow({
  t,
  focused,
  selected,
  me,
  mailbox,
  userLabels,
  now,
  showCategory,
  reminder,
  topic,
  hue,
  score,
  isPrivate,
  onMenu,
}: {
  t: Thread;
  /** Right-click: the place-in-a-view menu for this row (or the selection
   *  it sits in). */
  onMenu: (t: Thread, x: number, y: number) => void;
  /** Hidden from agents (lib/privacy). */
  isPrivate?: boolean;
  /** While a list is being tuned: this row's score on its lens. */
  score?: number;
  /** The hue of the section the row sits in, when the inbox shows as
   *  topics: the row drops the lane chip and takes the section's colour. */
  hue?: number;
  focused: boolean;
  selected: boolean;
  me?: Sender;
  /** Set only in the unified view with several accounts: renders the
   *  per-account marker dot. */
  mailbox?: Mailbox;
  userLabels: Map<string, Label>;
  now: number;
  /** Off inside a lane's own view — the chip would repeat the header. */
  showCategory: boolean;
  reminder?: Reminder;
  /** The thread's topic, when there is one and the list is not that topic's
   *  own view. */
  topic?: Cluster;
}): React.ReactElement {
  // Label ids are per-mailbox; chips resolve within the thread's account.
  // A topic is the finer signal, so its chip stands in for the lane's; the
  // lane still reads in the topic chip's tooltip.
  const laneMeta = categoryMeta(t.category);
  const lane = showCategory && !topic && hue === undefined ? laneMeta : null;
  const chips = (
    t.label_ids
      .map((id) => userLabels.get(`${t.account_id}:${id}`))
      .filter(Boolean) as Label[]
  ) // A user label spelling out the lane again ("Travel Travel") is noise.
    .filter((l) => l.name.toLowerCase() !== lane?.name.toLowerCase());
  // A finger swipes the row: left files it away, right flips read.
  const rowRef = useRef<HTMLDivElement>(null);
  const swipes = useCallback(() => ({
    left: { label: "Archive", removes: true, run: () => useMailStore.getState().archive([t._id]) },
    right: { label: t.is_unread ? "Read" : "Unread", run: () => useMailStore.getState().setRead(t.is_unread, [t._id]) },
  }), [t._id, t.is_unread]);
  useSwipe(rowRef, swipes);
  return (
    <div
      ref={rowRef}
      className={[
        "row",
        t.is_unread ? "is-unread" : "",
        focused ? "is-focused" : "",
        selected ? "is-selected" : "",
        hue !== undefined ? "in-section" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={hue !== undefined ? { ["--hue" as any]: hue } : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) useMailStore.getState().toggleSelect(t._id);
        else useMailStore.getState().openThread(t._id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(t, e.clientX, e.clientY);
      }}
      draggable
      onDragStart={(e) => startMailDrag(e, rowGesture(t))}
      onMouseEnter={() => {
        // Hover moves nothing — the keyboard cursor is sovereign. Click selects.
      }}
    >
      <span className="row-mark" aria-hidden />
      {mailbox && (
        <span
          className="row-acct-dot"
          style={{ ["--acct" as any]: mailbox.color }}
          title={mailbox.email}
          aria-hidden
        />
      )}
      <button
        className={`row-star${t.is_starred ? " is-on" : ""}`}
        tabIndex={-1}
        title="Star (s)"
        onClick={(e) => {
          e.stopPropagation();
          useMailStore.getState().toggleStar(t._id);
        }}
      >
        {t.is_starred ? "★" : "☆"}
      </button>
      <span className="row-from">{participantsLine(t, me)}</span>
      <span className="row-text">
        <span className="row-subject">{t.subject || "(no subject)"}</span>
        <span className="row-snippet">{t.snippet}</span>
      </span>
      <span className="row-meta">
        {score !== undefined && <span className="row-score" title="Its score on this list; the slider is the cutoff">{score}</span>}
        {reminder && (
          <span
            className="row-chip row-remind"
            data-fired={reminder.status === "fired" || undefined}
            title={
              reminder.status === "fired"
                ? "Came due with no reply"
                : reminder.kind === "snooze"
                  ? "Snoozed"
                  : "Watching for a reply"
            }
          >
            {reminder.status === "fired"
              ? "no reply"
              : dueLabel(reminder.remind_at, now)}
          </span>
        )}
        {topic && (
          <button
            className="row-chip row-topic"
            style={{ ["--hue" as any]: topic.hue }}
            title={`${topic.name}${topic.description ? ` — ${topic.description}` : ""}${laneMeta ? ` · filed under ${laneMeta.name}` : ""}. Click opens the topic; T moves this conversation.`}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              useMailStore.getState().setView(`cluster:${topic._id}`);
            }}
          >
            {topic.name}
          </button>
        )}
        {lane && (
          <span
            className="row-chip row-lane"
            style={{ ["--hue" as any]: lane.hue }}
            title={`Filed under ${lane.name} — m to re-file`}
          >
            {lane.name}
          </span>
        )}
        {chips.slice(0, 2).map((l) => (
          <span
            key={l._id}
            className="row-chip"
            style={l.color ? { background: l.color.bg, color: l.color.fg } : undefined}
          >
            {l.name}
          </span>
        ))}
        {isPrivate && <LockIcon />}
        {t.has_attachments && <ClipIcon />}
      </span>
      {/* Outside the meta group: a phone card lifts the date to the sender's line. */}
      <span className="row-date">{relativeDate(t.last_at, now)}</span>
    </div>
  );
});

export function ThreadList(): React.ReactElement {
  const s = useTracked([
    (s) => s.threads,
    (s) => s.activeView,
    (s) => s.focusedThreadId,
    (s) => s.selected,
    (s) => s.labels,
    (s) => s.clusters,
    (s) => s.accounts,
    (s) => s.accountScope,
    (s) => s.searchOpen,
    (s) => s.searchQuery,
    (s) => s.searchStatus,
    (s) => s.searchHits,
    (s) => s.searchHasMore,
    (s) => s.reminders,
    // Whether the inbox shows as topics is a client preference; without
    // this dep the switch would not repaint until something else did.
    (s) => s.clientState,
    (s) => s.lensPanel,
  ]);
  const now = useCoarseNow(30_000);
  const parentRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ ids: string[]; x: number; y: number } | null>(null);
  const openMenu = useCallback((t: Thread, x: number, y: number) => {
    const ids = rowGesture(t);
    // A row outside the selection becomes the cursor, like a click.
    if (ids.length === 1) useMailStore.getState().focusThread(t._id);
    setMenu({ ids, x, y });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  // While the search bar has text, the list live-filters on every keystroke —
  // instant, from the local index. Enter commits the view and adds the deep
  // (whole-mailbox) pass on top.
  const liveQuery = s.searchOpen ? s.searchQuery.trim() : "";
  const view = liveQuery ? (`search:${liveQuery}` as const) : s.activeView;

  // A topic's own page holds everything in it, streams included; the
  // loose page holds the mail no topic claimed.
  const root = viewRoot(view);
  const lenses = inboxLenses(s);
  const rules = privacyRules(s);
  const tuning = s.lensPanel === "tune" && isInboxList(view) ? viewLensId(view) : null;
  const threads = useMemo(
    () => (root ? (root === LOOSE_SECTION ? loosePile(s.threads, s.clusters, s.accountScope) : topicPile(s.threads, s.clusters, s.accountScope, root))?.threads ?? [] : visibleThreads(s.threads, view, s.searchHits, s.accountScope, s.reminders, s.labels, lenses)),
    [root, s.threads, s.clusters, view, s.searchHits, s.accountScope, s.reminders, s.labels, lenses],
  );
  // The inbox as topics when the person asked for it, and a topic's own
  // page: the rows are then section heads, conversations, "N more" lines
  // and the muted footer, in one list the cursor walks end to end. Every
  // other view is a plain list.
  const grouping = inboxGrouping(s);
  const hasTopics = useMemo(() => Object.values(s.clusters).some((c) => !c.deleted), [s.clusters]);
  const inboxList = isInboxList(view);
  const grouped = !!root || (inboxList && grouping.grouped && hasTopics);
  const items: InboxItem[] = useMemo(
    () => grouped ? inboxItems(s.threads, s.clusters, s.accountScope, root, viewSlice(view, lenses) ?? ALL_INBOX) : threads.map((t) => ({ kind: "thread", id: t._id, thread: t })),
    [grouped, s.threads, s.clusters, s.accountScope, root, threads, view, lenses],
  );
  const groupingOff = (s.clientState.clustering ?? s.clientState.prefs?.clustering)?.enabled === false;
  const grouping_accounts = useMemo(() => (Object.values(s.accounts) as Account[]).filter((a) => a.clustering && inScope({ account_id: a._id }, s.accountScope)), [s.accounts, s.accountScope]);
  // Chips only where they inform: reminders everywhere they exist, the lane
  // chip everywhere except the lane's own view.
  const reminders = useMemo(() => liveReminders(s.reminders), [s.reminders]);
  const showCategory = !view.startsWith("cat:");
  // The topic chip everywhere a topic exists, except where the section or
  // the page already names it.
  const topicView = view.startsWith("cluster:") ? view.slice(8) : null;
  const topicOf = (t: Thread): Cluster | undefined => {
    if (grouped || !t.cluster_id) return undefined;
    const c = shownTopic(s.clusters[t.cluster_id], s.clusters);
    return c && c._id !== topicView ? c : undefined;
  };
  const userLabels = useMemo(() => {
    // Keyed by account:gmail_id — label ids repeat across mailboxes.
    const m = new Map<string, Label>();
    for (const l of Object.values(s.labels) as Label[]) {
      if (l.kind === "user") m.set(`${l.account_id}:${l.gmail_id}`, l);
    }
    return m;
  }, [s.labels]);
  const accountList = useMemo(
    () => orderedAccounts(s.accounts) as Account[],
    [s.accounts],
  );
  // Markers only where they disambiguate: unified view, several accounts.
  const showAccountDots = s.accountScope === "all" && accountList.length > 1;
  // One stable marker per account, so memoized rows keep their props.
  const mailboxes = useMemo(
    () => new Map<string, Mailbox>(accountList.map((a) => [a._id, { email: a.email, color: accountColor(s.accounts, a._id) }])),
    [accountList, s.accounts],
  );

  // A phone stacks each row into a card; the height matches --row-h there.
  const narrow = useNarrow();
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (items[i]?.kind === "thread" ? (narrow ? 80 : 44) : items[i]?.kind === "section" ? 52 : 32),
    overscan: 12,
  });
  useEffect(() => virtualizer.measure(), [narrow, virtualizer]);

  // Keep the keyboard cursor on screen — but only scroll when the cursor
  // actually MOVES (j/k, a view change), not when incoming mail reorders the
  // list under a stationary cursor. Keying off focusedThreadId (not its index)
  // means a reorder that shifts the row's index no longer yanks the viewport.
  const focusedIndex = items.findIndex((i) => i.id === s.focusedThreadId);
  const lastFocusedId = useRef<string | null>(null);
  useEffect(() => {
    if (s.focusedThreadId !== lastFocusedId.current) {
      lastFocusedId.current = s.focusedThreadId;
      if (focusedIndex >= 0) virtualizer.scrollToIndex(focusedIndex, { align: "auto" });
    }
  }, [s.focusedThreadId, focusedIndex, virtualizer]);

  // A committed search pages Gmail: reaching the end of what has landed, by
  // scroll or by cursor, asks for the next page.
  const isSearch = view.startsWith("search:");
  const virtualItems = virtualizer.getVirtualItems();
  const lastShown = Math.max(
    virtualItems[virtualItems.length - 1]?.index ?? -1,
    focusedIndex,
  );
  const nearEnd = items.length > 0 && lastShown >= items.length - 6;
  useEffect(() => {
    if (isSearch && nearEnd && s.searchHasMore && s.searchStatus === "idle") {
      useMailStore.getState().loadMoreSearch();
    }
  }, [isSearch, nearEnd, s.searchHasMore, s.searchStatus, items.length]);

  const selCount = Object.keys(s.selected).length;
  const labelName = view.startsWith("label:")
    ? (Object.values(s.labels) as Label[]).find(
        (l) => l.gmail_id === view.slice(6),
      )?.name
    : undefined;

  if (view === "drafts") return <DraftList />;
  const searching = isSearch && s.searchStatus === "searching";

  return (
    <div className="list">
      <header className="list-head">
        <NavButton />
        {inboxList ? (
          <h1 className="list-title"><LensTabs view={view} /></h1>
        ) : (
          <h1 className="list-title">{viewTitle(view, view.startsWith("cluster:") ? s.clusters[view.slice(8)]?.name : labelName)}</h1>
        )}
        {searching && (
          <span className="list-searching">
            <span className="spin" aria-hidden /> searching all mail
          </span>
        )}
        {/* The switch already says how much waits in each inbox list. */}
        {!inboxList && (
          <span className="list-count">
            {threads.length > 0 ? `${threads.length}` : ""}
          </span>
        )}
        {inboxList && <GroupToggle grouped={grouping.grouped} ready={hasTopics} off={groupingOff} />}
        <SearchButton />
      </header>
      {inboxList && <LensPanel view={view} />}
      {topicView && <TopicHead clusterId={topicView} threads={threads} />}
      {inboxList && grouping_accounts.length > 0 && (grouped || !hasTopics) && <div className="topic-head"><GroupingProgress accounts={grouping_accounts} many={grouping_accounts.length > 1} /></div>}
      {threads.length === 0 ? (
        searching ? (
          <div className="empty-state">
            <div className="empty-title">Searching…</div>
            <div className="empty-sub">Asking Gmail for matches beyond the local index.</div>
          </div>
        ) : (
          <EmptyState view={view} />
        )
      ) : (
        <div className="list-scroll" ref={parentRef}>
          <div
            className="list-inner"
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((v) => {
              const item = items[v.index];
              const focused = item.id === s.focusedThreadId;
              return (
                <div
                  key={item.id}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: v.size,
                    transform: `translateY(${v.start}px)`,
                  }}
                >
                  {item.kind === "thread" ? (
                    <ThreadRow
                      t={item.thread}
                      isPrivate={threadPrivacy(item.thread, rules) === "private"}
                      focused={focused}
                      selected={!!s.selected[item.id]}
                      hue={item.hue}
                      me={s.accounts[item.thread.account_id]}
                      mailbox={showAccountDots && item.hue === undefined ? mailboxes.get(item.thread.account_id) : undefined}
                      userLabels={userLabels}
                      now={now}
                      showCategory={showCategory}
                      reminder={reminderFor(reminders, item.thread)}
                      topic={topicOf(item.thread)}
                      onMenu={openMenu}
                      score={tuning ? (item.thread.lens_marks?.[tuning] !== undefined ? (item.thread.lens_marks[tuning] ? 100 : 0) : item.thread.lens_scores?.[tuning]) : undefined}
                    />
                  ) : item.kind === "section" ? (
                    <SectionRow item={item} focused={focused} mailbox={showAccountDots && item.pile.meta.cluster ? mailboxes.get(item.pile.meta.cluster.account_id) : undefined} />
                  ) : item.kind === "more" ? (
                    <MoreRow item={item} />
                  ) : (
                    <MutedFoot item={item} />
                  )}
                </div>
              );
            })}
          </div>
          {isSearch && (searching || s.searchHasMore) && (
            <div className="list-more">
              {searching ? (
                <span className="list-searching">
                  <span className="spin" aria-hidden /> loading more
                </span>
              ) : (
                <button
                  className="sel-link"
                  onClick={() => useMailStore.getState().loadMoreSearch()}
                >
                  load more
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {menu && (
        <PopMenu x={menu.x} y={menu.y} onClose={closeMenu}>
          <LensMenuItems ids={menu.ids} onDone={closeMenu} />
        </PopMenu>
      )}
      {selCount > 0 && (
        <div className="sel-bar">
          <span className="sel-count">{selCount} selected</span>
          <span className="sel-actions">
            <HintPair clickable spec="T">topic</HintPair>
            <HintPair clickable spec="e">archive</HintPair>
            <HintPair clickable spec="#">trash</HintPair>
            <HintPair clickable spec="m">file</HintPair>
            <HintPair clickable spec="z">snooze</HintPair>
            <HintPair clickable spec="escape">clear</HintPair>
          </span>
        </div>
      )}
    </div>
  );
}
