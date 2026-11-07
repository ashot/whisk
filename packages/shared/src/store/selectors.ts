import {
  L,
  type AccountScope,
  type Cluster as TopicCluster,
  type Draft,
  type Label,
  type Message,
  type Reminder,
  type Thread,
  type ViewId,
} from "./types";
import { CATEGORIES, type CategoryId, type CategoryMeta } from "../lib/categories";
import { inHiddenTopic } from "../lib/notifications";
import { matchThread, parseQuery } from "../lib/searchQuery";
export { inHiddenTopic };

/** Remember one answer per argument tuple. The store replaces a collection
 *  object whenever a row in it changes, so reference equality on the
 *  arguments is exactly "nothing relevant moved", and the rail, the sweep
 *  and the picker share one computation per store change. */
function memoLast<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let lastArgs: A | null = null;
  let lastResult: R;
  return (...args: A) => {
    if (lastArgs && lastArgs.length === args.length && lastArgs.every((a, i) => a === args[i])) return lastResult;
    lastArgs = args;
    lastResult = fn(...args);
    return lastResult;
  };
}


/** Which slice of the inbox: what the person sees first, the rest, or both. */
export type InboxPart = "important" | "other" | "all";

/** `memoLast` once per inbox part, so the lists that read different parts
 *  in one render keep their own answers instead of trading one cache. */
function memoPerPart<A extends unknown[], R>(fn: (...args: [...A, InboxPart]) => R): (...args: [...A, InboxPart?]) => R {
  const memos = new Map<InboxPart, (...args: [...A, InboxPart]) => R>();
  const arity = fn.length - 1;
  return (...args) => {
    // Positional: optional arguments before the part may be left off, so
    // pad to the function's arity rather than trusting args.length.
    const part = ((args[arity] as InboxPart | undefined) ?? "all");
    const rest = Array.from({ length: arity }, (_, i) => args[i]) as unknown as A;
    let memo = memos.get(part);
    if (!memo) memos.set(part, (memo = memoLast(fn)));
    return memo(...rest, part);
  };
}

/** In Gmail's inbox, and not in trash or spam. */
export function inGmailInbox(t: Thread): boolean {
  return !t.deleted && t.label_ids.includes(L.INBOX) && !t.label_ids.includes(L.TRASH) && !t.label_ids.includes(L.SPAM);
}

/** Whether an inbox thread sits in a part. Only a verdict of "not
 *  important" moves a thread to Other: mail the model has not judged yet
 *  shows first, so nothing is hidden before anything has read it. */
export function inInboxPart(t: Thread, part: InboxPart): boolean {
  if (!inGmailInbox(t)) return false;
  if (part === "all") return true;
  return (t.important === false) === (part === "other");
}

/** Whether a row belongs to the active account scope. Rows without an
 *  account_id (legacy local drafts) count as in-scope everywhere. */
export function inScope(
  row: { account_id?: string },
  scope: AccountScope | undefined,
): boolean {
  if (!scope || scope === "all") return true;
  return !row.account_id || row.account_id === scope;
}

// Which threads belong to a view. Pure and total — the store filters its
// whole (local, already-synced) thread cache through this on every render,
// so view switches are instant and offline-correct.
export function threadInView(
  t: Thread,
  view: ViewId,
  /** Lets a search view answer label:<name>; ids work without it. */
  labels?: Record<string, Label>,
): boolean {
  if (t.deleted) return false;
  const has = (id: string) => t.label_ids.includes(id);
  if (view === "inbox") return inInboxPart(t, "important");
  if (view === "other") return inInboxPart(t, "other");
  if (view === "starred") return has(L.STARRED) && !has(L.TRASH) && !has(L.SPAM);
  if (view === "sent") return has(L.SENT) && !has(L.TRASH) && !has(L.SPAM);
  if (view === "trash") return has(L.TRASH);
  if (view === "spam") return has(L.SPAM);
  if (view === "archive")
    return !has(L.INBOX) && !has(L.TRASH) && !has(L.SPAM) && !has(L.DRAFT);
  if (view === "drafts") return false; // drafts render from the drafts store, not threads
  // Reminder-driven views (later, waiting) and the sweep join against the
  // reminders table in visibleThreads — a thread row alone can't answer them.
  if (view === "later" || view === "waiting" || view === "sweep") return false;
  if (view.startsWith("cat:")) {
    const lane = view.slice("cat:".length);
    if (!has(L.INBOX) || has(L.TRASH) || has(L.SPAM)) return false;
    return lane === "primary" ? !t.category : t.category === lane;
  }
  // A topic view is the inbox slice of one cluster; "none" is the inbox
  // mail no topic claimed.
  if (view.startsWith("cluster:")) {
    const id = view.slice("cluster:".length);
    if (!has(L.INBOX) || has(L.TRASH) || has(L.SPAM)) return false;
    return id === "none" ? !t.cluster_id : t.cluster_id === id;
  }
  if (view.startsWith("label:")) {
    return has(view.slice("label:".length)) && !has(L.TRASH) && !has(L.SPAM);
  }
  // The live filter speaks the same grammar as the server's projection search
  // (free text over subject, snippet and people; from:, to:, label:,
  // is:unread, is:starred, has:attachment), so what a keystroke shows is what
  // Enter confirms. Gmail's remote pass adds what only bodies can answer.
  if (view.startsWith("search:")) {
    const q = view.slice("search:".length).trim();
    if (!q) return false;
    return (
      !has(L.TRASH) &&
      !has(L.SPAM) &&
      matchThread(t, parsedSearch(q), labelNames(labels))
    );
  }
  return false;
}

const parsedSearch = memoLast((q: string) => parseQuery(q));
const labelNames = memoLast((labels?: Record<string, Label>) => {
  const names = new Map<string, string>();
  for (const id in labels ?? {}) {
    const l = labels![id];
    if (!l.deleted) names.set(l.gmail_id, l.name);
  }
  return names;
});

export function sortThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => b.last_at - a.last_at);
}

/** Armed/fired reminders keyed by `${account_id}:${thread_gmail_id}` — the
 *  join the later/waiting views and the row chips read through. */
export function liveReminders(
  reminders: Record<string, Reminder>,
): Map<string, Reminder> {
  const map = new Map<string, Reminder>();
  for (const id in reminders) {
    const r = reminders[id];
    if (r.deleted || (r.status !== "armed" && r.status !== "fired")) continue;
    map.set(`${r.account_id}:${r.thread_gmail_id}`, r);
  }
  return map;
}

export function reminderFor(
  reminders: Map<string, Reminder>,
  t: Thread,
): Reminder | undefined {
  return reminders.get(`${t.account_id}:${t.gmail_id}`);
}

export function visibleThreads(
  all: Record<string, Thread>,
  view: ViewId,
  searchHits?: readonly string[],
  scope?: AccountScope,
  reminders?: Record<string, Reminder>,
  labels?: Record<string, Label>,
): Thread[] {
  // Later = parked behind an armed snooze; Waiting = a follow-up watch, armed
  // (still quiet) or fired (came due with no reply). Soonest due first — the
  // row order IS the schedule.
  if (view === "later" || view === "waiting") {
    const live = liveReminders(reminders ?? {});
    const out: Array<{ t: Thread; r: Reminder }> = [];
    for (const id in all) {
      const t = all[id];
      if (t.deleted || !inScope(t, scope)) continue;
      const r = reminderFor(live, t);
      if (!r) continue;
      if (view === "later" ? r.kind !== "snooze" : r.kind !== "followup") continue;
      out.push({ t, r });
    }
    return out.sort((a, b) => a.r.remind_at - b.r.remind_at).map((x) => x.t);
  }
  // Remote search hits (matched by Gmail on full bodies) join the local text
  // matches — a hit is a hit even when the words live outside the projection.
  const hits =
    view.startsWith("search:") && searchHits?.length
      ? new Set(searchHits)
      : null;
  const out: Thread[] = [];
  for (const id in all) {
    const t = all[id];
    if (!inScope(t, scope)) continue;
    if (
      threadInView(t, view, labels) ||
      (hits !== null &&
        !t.deleted &&
        hits.has(t.gmail_id) &&
        !t.label_ids.includes(L.TRASH) &&
        !t.label_ids.includes(L.SPAM))
    ) {
      out.push(t);
    }
  }
  return sortThreads(out);
}

/** Drafts are a list like any other view — newest edit first. */
export function visibleDrafts(
  all: Record<string, Draft>,
  scope?: AccountScope,
): Draft[] {
  return (Object.values(all) as Draft[])
    .filter((d) => inScope(d, scope))
    .sort((a, b) => b.updated_at - a.updated_at);
}

/** Whether a draft belongs inside this conversation: a reply or a forward
 *  of it, which both land in the thread once sent. */
export function draftsIn(draft: Pick<Draft, "mode" | "thread_gmail_id">, threadGmailId: string): boolean {
  return draft.mode !== "new" && draft.thread_gmail_id === threadGmailId;
}

/** The replies and forwards drafted in a conversation, oldest first: they
 *  sit under its messages, where they will land once sent. */
export function threadDrafts(all: Record<string, Draft>, threadGmailId: string): Draft[] {
  return (Object.values(all) as Draft[])
    .filter((d) => draftsIn(d, threadGmailId))
    .sort((a, b) => a.updated_at - b.updated_at);
}

/** A client preference: the local write lands at the top of client_state,
 *  the server echo folds it into `prefs`. Either is current. */
export function clientPref<T = any>(state: { clientState: Record<string, any> }, key: string): T | undefined {
  return state.clientState[key] ?? state.clientState.prefs?.[key];
}

/** Whether the inbox shows as topics. Off by default: the plain list is
 *  the simple path. */
export function inboxGrouping(state: { clientState: Record<string, any> }): { grouped: boolean } {
  const pref = clientPref<{ grouped?: boolean }>(state, "inbox");
  return { grouped: pref?.grouped === true };
}

export const TOPIC_ROW = "topic:";
/** The section holding inbox mail no topic claimed. */
export const LOOSE_SECTION = "none";
/** How many conversations a section shows before it says "N more". A
 *  section one over the limit shows everything: "1 more" is a worse deal
 *  than the row. */
export const SECTION_PEEK = 3;

/** One row of the inbox shown as topics: a section head (a topic, or the
 *  mail no topic claimed), a conversation, the "N more" line closing a
 *  section that runs past its peek, or the footer naming muted topics.
 *  `hue` on a conversation is the section it sits in. Only heads and
 *  conversations are cursor stops. */
export type InboxItem =
  | { kind: "thread"; id: string; thread: Thread; hue?: number }
  | { kind: "section"; id: string; pile: Pile; shown: number }
  | { kind: "more"; id: string; pile: Pile; rest: number }
  | { kind: "muted"; id: string; piles: Pile[] };

export function topicRowId(clusterId: string): string {
  return `${TOPIC_ROW}${clusterId}`;
}

/** A theme with what it holds: its streams, and the mail sitting in it
 *  directly. `pile.threads` is everything, so a gesture on the theme
 *  reaches all of it. */
export type ThemeNode = { pile: Pile; streams: Pile[]; direct: Thread[] };

/**
 * The topics as a tree: themes with their streams inside, then the streams
 * that sit in no theme. Built on `topicClusters`, which counts inbox mail
 * per cluster; a theme's own pile is the union. The screen shows one level:
 * the themes and the loose streams, side by side (`topLevel`).
 */
export const topicTree = memoPerPart(function topicTree(
  all: Record<string, Thread>,
  clusters: Record<string, TopicCluster>,
  scope: AccountScope | undefined,
  part: InboxPart,
): { themes: ThemeNode[]; loose: Pile[] } {
  const piles = topicClusters(all, clusters, scope, part);
  const byId = new Map(piles.map((p) => [p.meta.id, p]));
  const themes: ThemeNode[] = [];
  const inTheme = new Set<string>();
  for (const id in clusters) {
    const c = clusters[id];
    if (c.deleted || c.kind !== "theme" || !inScope(c, scope)) continue;
    // A muted stream leaves its theme: it stands on its own, in the footer.
    const streams = piles.filter((p) => p.meta.cluster?.parent_id === c._id && p.threads.length > 0 && !p.meta.cluster?.hidden);
    const direct = byId.get(c._id)?.threads ?? [];
    const threads = [...direct, ...streams.flatMap((p) => p.threads)];
    if (threads.length === 0 && c.source !== "user" && !c.pinned) continue;
    for (const p of streams) inTheme.add(p.meta.id);
    const pile = tallyPile(topicMeta(c), threads);
    themes.push({ pile, streams: streams.sort((a, b) => newestOf(b) - newestOf(a)), direct });
  }
  const loose = piles.filter((p) => !p.meta.cluster?.kind && !inTheme.has(p.meta.id) && (!p.meta.cluster?.parent_id || p.meta.cluster.hidden || p.threads.length > 0));
  return { themes: themes.sort((a, b) => b.pile.threads.length - a.pile.threads.length), loose };
});

/** The topics the screen shows: every theme, and every stream in no theme. */
export function topLevel(all: Record<string, Thread>, clusters: Record<string, TopicCluster>, scope: AccountScope | undefined, part: InboxPart = "all"): Pile[] {
  const tree = topicTree(all, clusters, scope, part);
  return [...tree.themes.map((n) => n.pile), ...tree.loose];
}

/** The topic a conversation shows: the theme its stream sits in, else the
 *  stream itself. Streams are how Whisk files mail; themes are what the
 *  person sees. */
export function shownTopic(c: TopicCluster | undefined, clusters: Record<string, TopicCluster>): TopicCluster | undefined {
  if (!c || c.deleted) return undefined;
  const parent = c.parent_id ? clusters[c.parent_id] : undefined;
  return parent && !parent.deleted && parent.kind === "theme" ? parent : c;
}

/** The pile a topic id stands for: a theme's whole contents, or a stream. */
export function topicPile(all: Record<string, Thread>, clusters: Record<string, TopicCluster>, scope: AccountScope | undefined, id: string): Pile | undefined {
  const tree = topicTree(all, clusters, scope);
  return tree.themes.find((n) => n.pile.meta.id === id)?.pile ?? tree.themes.flatMap((n) => n.streams).find((p) => p.meta.id === id) ?? tree.loose.find((p) => p.meta.id === id);
}

function newestOf(p: Pile): number {
  return p.threads[0]?.last_at ?? 0;
}

/** Whether a topic is muted, on its own or through the theme it sits in. */
export function topicMuted(c: TopicCluster | undefined, clusters: Record<string, TopicCluster>): boolean {
  if (!c) return false;
  if (c.hidden) return true;
  const parent = c.parent_id ? clusters[c.parent_id] : undefined;
  return !!parent && !parent.deleted && !!parent.hidden;
}

/** Inbox mail in scope that no topic claimed, newest first. */
export function loosePile(all: Record<string, Thread>, clusters: Record<string, TopicCluster>, scope: AccountScope | undefined, part: InboxPart = "all"): Pile {
  const claimed = new Set(topLevel(all, clusters, scope, part).flatMap((p) => p.threads.map((t) => t._id)));
  const threads = sortThreads(Object.values(all).filter((t) => inScope(t, scope) && inInboxPart(t, part) && !claimed.has(t._id)));
  return tallyPile({ id: LOOSE_SECTION, name: "Everything else", hint: "Inbox conversations no topic claimed", hue: 0, view: `cluster:${LOOSE_SECTION}` }, threads);
}

/**
 * The inbox shown as topics: one section per topic, the one with the
 * newest conversation first, then the mail no topic claimed as one last
 * section shown in full. A topic's section is its head, its newest few
 * conversations, and "N more" when it runs past the peek; nothing in the
 * inbox is missing, only folded behind that line. Muted topics are one
 * footer line. A topic's own page (`root`) is every conversation in it,
 * newest first.
 */
export const inboxItems = memoLast(function inboxItems(
  all: Record<string, Thread>,
  clusters: Record<string, TopicCluster>,
  scope: AccountScope | undefined,
  root?: string,
  /** Which list is grouped; a topic's own page always holds all of it. */
  part: InboxPart = "all",
): InboxItem[] {
  const out: InboxItem[] = [];
  if (root) {
    const pile = root === LOOSE_SECTION ? loosePile(all, clusters, scope) : topicPile(all, clusters, scope, root);
    for (const t of pile?.threads ?? []) out.push({ kind: "thread", id: t._id, thread: t });
    return out;
  }
  const muted = (p: Pile) => topicMuted(p.meta.cluster, clusters);
  const piles = topLevel(all, clusters, scope, part);
  const loose = loosePile(all, clusters, scope, part);
  const section = (p: Pile, peek: number) => {
    const whole = p.threads.length <= peek + 1;
    const shown = whole ? p.threads : p.threads.slice(0, peek);
    out.push({ kind: "section", id: topicRowId(p.meta.id), pile: p, shown: shown.length });
    for (const t of shown) out.push({ kind: "thread", id: t._id, thread: t, hue: p.meta.cluster ? p.meta.hue : undefined });
    if (!whole) out.push({ kind: "more", id: `more:${p.meta.id}`, pile: p, rest: p.threads.length - shown.length });
  };
  // A topic with no inbox mail has no section to show; it still has its
  // page, its place in the picker, and its line in the footer when muted.
  for (const p of piles.filter((p) => !muted(p) && p.threads.length > 0).sort((a, b) => newestOf(b) - newestOf(a))) section(p, SECTION_PEEK);
  if (loose.threads.length) section(loose, Infinity);
  const mutedPiles = piles.filter(muted);
  if (mutedPiles.length > 0) out.push({ kind: "muted", id: "muted", piles: mutedPiles });
  return out;
});

/** The two inbox lists: what the person sees first, and the rest. */
export function isInboxList(view: ViewId): view is "inbox" | "other" {
  return view === "inbox" || view === "other";
}

/** The inbox part a view lists, for grouping it as topics. */
export function viewPart(view: ViewId): InboxPart {
  return view === "inbox" ? "important" : view === "other" ? "other" : "all";
}

/** Threads per inbox list, with unread counts: the numbers on the switch
 *  between Important and Other. */
export function inboxPartCounts(
  all: Record<string, Thread>,
  scope?: AccountScope,
): Record<"important" | "other", LaneCount> {
  const out = { important: { total: 0, unread: 0 }, other: { total: 0, unread: 0 } };
  for (const id in all) {
    const t = all[id];
    if (!inScope(t, scope) || !inGmailInbox(t)) continue;
    const entry = t.important === false ? out.other : out.important;
    entry.total++;
    if (t.is_unread) entry.unread++;
  }
  return out;
}

/** The topic view a list is rooted in, if any. */
export function viewRoot(view: ViewId): string | undefined {
  return view.startsWith("cluster:") ? view.slice("cluster:".length) : undefined;
}

/** The conversations a row stands for: a section's whole pile, or the one
 *  thread. So `e` on "Sentry Alerts" archives the whole topic. */
export function rowThreadIds(s: { threads: Record<string, Thread>; clusters: Record<string, TopicCluster>; accountScope?: AccountScope; activeView: ViewId }, id: string): string[] {
  if (id.startsWith(TOPIC_ROW)) {
    const item = inboxItems(s.threads, s.clusters, s.accountScope, viewRoot(s.activeView), viewPart(s.activeView)).find((i) => i.id === id);
    return item?.kind === "section" ? item.pile.threads.map((t) => t._id) : [];
  }
  return [id];
}

/** The ids the keyboard cursor walks in a view: draft client ids under Drafts,
 *  thread ids everywhere else. One cursor model, two kinds of row. */
export function visibleRowIds(
  s: {
    threads: Record<string, Thread>;
    drafts: Record<string, Draft>;
    activeView: ViewId;
    searchHits?: readonly string[];
    accountScope?: AccountScope;
    reminders?: Record<string, Reminder>;
    clusters?: Record<string, TopicCluster>;
    clientState?: Record<string, any>;
    labels?: Record<string, Label>;
  },
): string[] {
  if (s.activeView === "drafts") {
    return visibleDrafts(s.drafts, s.accountScope).map((d) => d.client_id);
  }
  // The sweep's cursor walks clusters, not rows — it owns its own focus.
  if (s.activeView === "sweep") return [];
  // The inbox as topics, and a topic's own page: section heads are stops
  // too; the "N more" line and the muted footer are not.
  const root = viewRoot(s.activeView);
  if (s.clusters && s.clientState && (root || (isInboxList(s.activeView) && inboxGrouping({ clientState: s.clientState }).grouped))) {
    return inboxItems(s.threads, s.clusters, s.accountScope, root, viewPart(s.activeView)).filter((i) => i.kind === "thread" || i.kind === "section").map((i) => i.id);
  }
  return visibleThreads(
    s.threads,
    s.activeView,
    s.searchHits,
    s.accountScope,
    s.reminders,
    s.labels,
  ).map((t) => t._id);
}
// ---------------------------------------------------------------------------
// Lanes and clusters
// ---------------------------------------------------------------------------

export type LaneCount = { total: number; unread: number };

/** Per-lane counts over the inbox (primary under the key "primary"). */
export function laneCounts(
  all: Record<string, Thread>,
  scope?: AccountScope,
): Map<CategoryId | "primary", LaneCount> {
  const counts = new Map<CategoryId | "primary", LaneCount>();
  for (const id in all) {
    const t = all[id];
    if (!inScope(t, scope) || !inGmailInbox(t)) continue;
    const lane = t.category ?? "primary";
    const entry = counts.get(lane) ?? { total: 0, unread: 0 };
    entry.total++;
    if (t.is_unread) entry.unread++;
    counts.set(lane, entry);
  }
  return counts;
}

export type SenderTally = { name: string; email: string; count: number };

/** What a sweep card needs to know about its pile, whether the pile is a
 *  lane (fixed taxonomy) or a topic (a cluster row). */
export type ClusterMeta = {
  id: string;
  name: string;
  hint: string;
  hue: number;
  /** The view Enter opens. */
  view: ViewId;
  /** Present for topics: the cluster row behind the card. */
  cluster?: TopicCluster;
};

export type Pile = {
  meta: ClusterMeta;
  threads: Thread[];
  unread: number;
  /** Distinct senders by volume — the "who is this pile" line on a card. */
  senders: SenderTally[];
};

function laneMeta(meta: CategoryMeta): ClusterMeta {
  return { id: meta.id, name: meta.name, hint: meta.hint, hue: meta.hue, view: `cat:${meta.id}` };
}

export function topicMeta(c: TopicCluster): ClusterMeta {
  return {
    id: c._id,
    name: c.name,
    hint: c.description,
    hue: c.hue,
    view: `cluster:${c._id}`,
    cluster: c,
  };
}

function tallyPile(meta: ClusterMeta, threads: Thread[]): Pile {
  const senders = new Map<string, SenderTally>();
  let unread = 0;
  for (const t of threads) {
    if (t.is_unread) unread++;
    const p = t.participants[0];
    if (!p) continue;
    const key = p.email.toLowerCase();
    const tally = senders.get(key) ?? {
      name: p.name ?? p.email,
      email: p.email,
      count: 0,
    };
    tally.count++;
    senders.set(key, tally);
  }
  return {
    meta,
    threads: sortThreads(threads),
    unread,
    senders: [...senders.values()].sort((a, b) => b.count - a.count),
  };
}

/**
 * One pile per cluster with inbox mail, biggest first: the mail sitting in
 * each stream, and in each theme directly. An empty stream still shows when
 * it is the person's. Unclustered inbox mail is not a pile — it is whatever
 * the topic view "none" lists.
 */
export const topicClusters = memoPerPart(function topicClusters(
  all: Record<string, Thread>,
  clusters: Record<string, TopicCluster>,
  scope: AccountScope | undefined,
  part: InboxPart,
): Pile[] {
  const byCluster = new Map<string, Thread[]>();
  for (const id in all) {
    const t = all[id];
    if (!inScope(t, scope) || !inInboxPart(t, part) || !t.cluster_id) continue;
    const list = byCluster.get(t.cluster_id) ?? [];
    list.push(t);
    byCluster.set(t.cluster_id, list);
  }
  const out: Pile[] = [];
  for (const id in clusters) {
    const c = clusters[id];
    if (c.deleted || !inScope(c, scope)) continue;
    const threads = byCluster.get(c._id) ?? [];
    if (threads.length === 0 && c.source !== "user" && !c.pinned) continue;
    out.push(tallyPile(topicMeta(c), threads));
  }
  return out.sort(
    (a, b) => b.threads.length - a.threads.length || a.meta.name.localeCompare(b.meta.name),
  );
});

/** Inbox threads in scope that no topic claimed. */
export function unclusteredCount(all: Record<string, Thread>, scope?: AccountScope): number {
  let n = 0;
  for (const id in all) {
    const t = all[id];
    if (inScope(t, scope) && threadInView(t, "cluster:none")) n++;
  }
  return n;
}

/**
 * The sweep: every non-primary lane present in the inbox, biggest first.
 * Threads inside a cluster stay in recency order so Enter drops into a
 * familiar list.
 */
export const inboxClusters = memoLast(function inboxClusters(
  all: Record<string, Thread>,
  scope?: AccountScope,
): Pile[] {
  const byLane = new Map<CategoryId, Thread[]>();
  for (const id in all) {
    const t = all[id];
    if (!inScope(t, scope) || !inGmailInbox(t) || !t.category) continue;
    const list = byLane.get(t.category) ?? [];
    list.push(t);
    byLane.set(t.category, list);
  }
  const clusters: Pile[] = [];
  for (const meta of CATEGORIES) {
    const threads = byLane.get(meta.id);
    if (!threads || threads.length === 0) continue;
    clusters.push(tallyPile(laneMeta(meta), threads));
  }
  return clusters.sort((a, b) => b.threads.length - a.threads.length);
});

/** Whether a message starts open when nothing has been toggled: the newest
 *  message and anything unread. Shared by the view and the key handlers so a
 *  toggle always flips what the reader actually sees. */
export function msgExpandedDefault(m: Message, index: number, count: number): boolean {
  return index === count - 1 || m.is_unread;
}

/** Unread inbox conversations, leaving out the topics the person muted:
 *  the point of muting is not to be nagged. */
export function inboxUnreadCount(
  all: Record<string, Thread>,
  scope?: AccountScope,
  clusters?: Record<string, TopicCluster>,
): number {
  let n = 0;
  for (const id in all) {
    const t = all[id];
    if (t.is_unread && inScope(t, scope) && threadInView(t, "inbox") && !inHiddenTopic(t, clusters)) n++;
  }
  return n;
}



/** Session accounts in stable attach order — the order the switcher shows and
 *  the g 1..9 bindings address. */
export function orderedAccounts(
  accounts: Record<string, { _id: string; _creationTime?: number; email: string }>,
): Array<{ _id: string; _creationTime?: number; email: string }> {
  return Object.values(accounts).sort(
    (a, b) => (a._creationTime ?? 0) - (b._creationTime ?? 0) || a.email.localeCompare(b.email),
  );
}

/** Account colours: Solarized's accents (green, magenta, cyan, violet,
 *  yellow, red, blue). Its orange is left out because the unread dot wears
 *  orange. */
const ACCOUNT_COLORS = ["#859900", "#d33682", "#2aa198", "#6c71c4", "#b58900", "#dc322f", "#268bd2"];

/** Initials on an account colour: Solarized's cream (base3). */
export const ACCOUNT_INK = "#fdf6e3";

/** An account's marker colour, by its place in `orderedAccounts`. */
export function accountColor(
  accounts: Record<string, { _id: string; _creationTime?: number; email: string }>,
  accountId: string,
): string {
  const i = orderedAccounts(accounts).findIndex((a) => a._id === accountId);
  return ACCOUNT_COLORS[Math.max(i, 0) % ACCOUNT_COLORS.length];
}

export function viewTitle(view: ViewId, labelName?: string): string {
  if (view.startsWith("label:")) return labelName ?? "Label";
  if (view === `cluster:${LOOSE_SECTION}`) return "Everything else";
  if (view.startsWith("cluster:")) return labelName ?? "Topic";
  if (view.startsWith("search:")) return `“${view.slice("search:".length)}”`;
  if (view.startsWith("cat:")) {
    const lane = view.slice("cat:".length);
    if (lane === "primary") return "Primary";
    return CATEGORIES.find((c) => c.id === lane)?.name ?? lane;
  }
  const names: Record<string, string> = {
    inbox: "Important",
    other: "Other",
    starred: "Starred",
    drafts: "Drafts",
    sent: "Sent",
    archive: "Archive",
    trash: "Trash",
    spam: "Spam",
    sweep: "Sweep",
    later: "Later",
    waiting: "Waiting",
  };
  return names[view] ?? view;
}
