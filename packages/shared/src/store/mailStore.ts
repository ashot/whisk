import type { Calendar, CalendarEvent } from "../lib/calendarTypes";
import {
  action,
  sync,
  createLocalFirstStore,
  createSyncEngine,
  type PendingEntry,
} from "@mail/platform";
import {
  L,
  type Account,
  type AccountScope,
  type Address,
  type Cluster,
  type ComposeMode,
  type Draft,
  type Filter,
  type FilterAction,
  type Label,
  type Memory,
  type Message,
  type OutgoingAttachment,
  type Reminder,
  type Thread,
  type ThreadOp,
  type ViewId,
} from "./types";
import { outgoingAsAttachments } from "../lib/attachments";
import {
  inboxClusters,
  inboxItems,
  viewRoot,
  msgExpandedDefault,
  orderedAccounts,
  clientPref,
  visibleRowIds,
  rowThreadIds,
  inboxGrouping,
  TOPIC_ROW,
  LOOSE_SECTION,
  topicRowId,
  shownTopic,
  topicPile,
  threadDrafts,
} from "./selectors";
import type { Pile } from "./selectors";
import { MAIL_PLATFORM_CONFIG } from "./registry";
import { remoteSearch } from "./searchBridge";

// A committed search keeps paging Gmail on its own until this many rows show;
// past that, the reader asks for more by scrolling to the end.
const SEARCH_PAGE_FILL = 40;
import { aiAvailable, aiClient } from "./aiBridge";
import { platformEnv } from "../env";
import type { CategoryId } from "../lib/categories";
import { seedCompose } from "../lib/compose";
import { fromAddress, isOwnAddress } from "../lib/sendAs";
import { categoryMeta } from "../lib/categories";
import { DEFAULT_IMPORTANCE_POLICY, importanceRevision, type ImportancePrefs } from "../lib/importance";

export type Toast = {
  id: number;
  text: string;
  kind: "info" | "undo" | "error";
  expiresAt: number;
};

type UndoEntry = { label: string; ops: ThreadOp[] };

export type SendPayload = {
  client_id: string;
  account_id?: string;
  /** The address it sends as; absent = the account's default. */
  from?: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  body_text: string;
  thread_gmail_id?: string;
  reply_to_gmail_id?: string;
  attachments?: OutgoingAttachment[];
};

export type MailState = {
  // ——— synced ———
  /** Every account this session holds, keyed by id. */
  accounts: Record<string, Account>;
  labels: Record<string, Label>;
  calendars: Record<string, Calendar>;
  events: Record<string, CalendarEvent>;
  calendarReady: boolean;
  calendarSyncError: string | null;
  calendarOpenId: string | null;
  calendarDialogOpen: boolean;
  setCalendarState: (state: { calendarReady?: boolean; calendarSyncError?: string | null; calendarOpenId?: string | null; calendarDialogOpen?: boolean }) => void;
  pruneCalendarAccounts: (ids: string[]) => void;
  threads: Record<string, Thread>;
  /** Detail cache: messages per thread, keyed by thread gmail_id, date asc. */
  threadMessages: Record<string, Message[]>;
  drafts: Record<string, Draft>;
  memories: Record<string, Memory>;
  reminders: Record<string, Reminder>;
  /** Topics the model found (or the person made) — the sweep by topic. */
  clusters: Record<string, Cluster>;
  /** Natural-language filters, judged by the model on new mail. */
  filters: Record<string, Filter>;
  clientState: Record<string, any>;
  pending: Record<string, PendingEntry>;
  syncMeta: { lastSyncAt?: number };

  // ——— ephemeral ———
  authToken: string | null;
  /** "all" = unified view; otherwise one account id. */
  accountScope: AccountScope;
  activeView: ViewId;
  lastNonSearchView: ViewId;
  focusedThreadId: string | null;
  openThreadId: string | null;
  selected: Record<string, true>;
  searchOpen: boolean;
  searchQuery: string;
  /** Remote (full-mailbox) search: in flight, the hit ids it has returned so
   *  far, and the page cursor (null once the mailbox is drained). */
  searchStatus: "idle" | "searching";
  searchHits: string[];
  searchCursor: string | null;
  searchHasMore: boolean;
  /** Per-message expansion overrides in the open thread, keyed by gmail_id.
   *  Absent = the default (last message and unread messages open). */
  msgExpanded: Record<string, boolean>;
  /** Message the n/p cursor rests on in the open thread (gmail_id). */
  msgFocusId: string | null;
  /** The rail as a drawer on a phone; any navigation closes it. */
  navOpen: boolean;
  paletteOpen: boolean;
  helpOpen: boolean;
  labelPickerOpen: boolean;
  categoryPickerOpen: boolean;
  /** Snooze/follow-up picker; null = closed. */
  timePicker: "snooze" | "followup" | null;
  memoriesOpen: boolean;
  settingsOpen: boolean;
  /** Cursor over the sweep's cards: the pile it is on, and where that was
   *  last seen, for when the pile vanishes (archived, merged away). */
  sweepIndex: number;
  sweepFocusId: string | null;
  /** The move-to-topic picker (T). */
  clusterPickerOpen: boolean;
  /** The filters overlay. */
  filtersOpen: boolean;
  /** Per-thread (gmail_id) summary state for the reader's catch-up card. */
  threadSummaries: Record<
    string,
    { status: "loading" | "done" | "error"; text?: string }
  >;
  /** An AI call is filling the open compose. */
  composeAiBusy: boolean;
  composeDraftId: string | null;
  composeMinimized: boolean;
  /** The recipients-and-subject editor over an inline reply. */
  composeHeadOpen: boolean;
  /** The file viewer over the open thread: which message's files, and which
   *  one is on screen. Null = closed. */
  attachmentViewer: { messageGmailId: string; index: number } | null;
  pendingKeys: string[];
  toasts: Toast[];
  undoStack: UndoEntry[];
  hydrated: boolean;

  // ——— sync recipes (wired by platform) ———
  syncTable: (field: string, incoming: any, opts?: any) => void;
  syncRecord: (field: string, id: string, record: any) => void;
  syncDetail: (field: string, key: string, value: any) => void;

  // ——— mail actions (optimistic, dispatched) ———
  // Dispatched actions take ONE payload object first — the server side effect
  // of the same name receives it as its args. Client-only extras follow.
  applyThreadOps: (payload: { ops: ThreadOp[] }, undoLabel?: string | null) => void;
  sendMessage: (payload: SendPayload) => void;
  saveDraft: (draft: Draft) => void;
  deleteDraft: (payload: { client_id: string }) => void;
  setClientPref: (key: string, value: any) => void;
  setCategory: (payload: {
    thread_gmail_ids: string[];
    category: CategoryId | null;
    account_id?: string;
    remember?: boolean;
  }) => void;
  /** Mark threads important or not by hand; null hands them back to the
   *  model. */
  setImportance: (payload: {
    thread_gmail_ids: string[];
    important: boolean | null;
    account_id?: string;
  }) => void;
  /** Save the importance policy; the server judges the recent inbox again. */
  setImportancePolicy: (payload: { policy: string }) => void;
  setReminder: (payload: {
    thread_gmail_id: string;
    kind: "snooze" | "followup";
    remind_at: number;
    account_id?: string;
  }) => void;
  cancelReminder: (payload: { thread_gmail_id: string; account_id?: string }) => void;
  addMemory: (payload: { text: string; contact_email?: string }) => void;
  deleteMemory: (payload: { memory_id: string }) => void;
  // Topic controls. Every one is the person's word: the model never undoes it.
  createCluster: (payload: {
    name: string;
    description?: string;
    thread_gmail_ids?: string[];
    account_id?: string;
  }) => void;
  renameCluster: (payload: {
    cluster_id: string;
    name?: string;
    description?: string;
    /** The theme a stream sits in; null takes it out. */
    parent_id?: string | null;
    account_id?: string;
  }) => void;
  mergeClusters: (payload: { from_ids: string[]; into_id: string; account_id?: string }) => void;
  dissolveCluster: (payload: { cluster_id: string; account_id?: string }) => void;
  setThreadCluster: (payload: {
    thread_gmail_ids: string[];
    cluster_id: string | null;
    account_id?: string;
  }) => void;
  regroupClusters: (payload: { fresh: boolean; account_id?: string }) => void;

  // ——— gestures (local only) ———
  setAuthToken: (token: string | null) => void;
  setHydrated: () => void;
  setView: (view: ViewId) => void;
  setAccountScope: (scope: AccountScope) => void;
  focusThread: (id: string | null) => void;
  moveFocus: (delta: number) => void;
  focusEdge: (edge: "first" | "last") => void;
  /**
   * The thread a link opened as a page of its own: no rail, no list, just
   * the conversation. Cleared by closing it or opening anything else, so
   * the app returns whole behind it.
   */
  soloThreadId: string | null;
  openThread: (id: string | null, opts?: { solo?: boolean }) => void;
  openDraft: (clientId: string) => void;
  openFocused: () => void;
  closeThread: () => void;
  toggleSelect: (id?: string) => void;
  /** Show the inbox as topics (a client preference; off is the plain list). */
  setInboxGrouped: (grouped: boolean) => void;
  setClusterTreatment: (payload: { cluster_id: string; hidden?: boolean; archive_new?: boolean; account_id?: string }) => void;
  /** Hide or unhide a topic: it leaves the inbox list, its mail stays. */
  hideTopic: (clusterId: string) => void;
  /** Hide or unhide the topic under the cursor (a section head, or a conversation with a topic). */
  hideFocusedTopic: () => void;
  clearSelection: () => void;
  setSearch: (open: boolean, query?: string) => void;
  commitSearch: () => void;
  /** The next page of whole-mailbox hits for the committed search. */
  loadMoreSearch: () => void;
  moveMsgFocus: (delta: number) => void;
  toggleMsgExpanded: (gmailId?: string) => void;
  setAllMsgExpanded: (open: boolean) => void;
  setNav: (open: boolean) => void;
  setPalette: (open: boolean) => void;
  setHelp: (open: boolean) => void;
  setLabelPicker: (open: boolean) => void;
  setCategoryPicker: (open: boolean) => void;
  setTimePicker: (mode: "snooze" | "followup" | null) => void;
  setMemories: (open: boolean) => void;
  setSettings: (open: boolean) => void;
  setClusterPicker: (open: boolean) => void;
  setFilters: (open: boolean) => void;
  moveSweep: (delta: number) => void;
  setSweepFocus: (id: string, index: number) => void;
  setPendingKeys: (keys: string[]) => void;
  dismissToast: (id: number) => void;
  pushToast: (text: string, kind?: Toast["kind"]) => void;

  // ——— high-level mail gestures ———
  archive: (ids?: string[]) => void;
  trash: (ids?: string[]) => void;
  markSpam: (ids?: string[]) => void;
  toggleStar: (id?: string) => void;
  setRead: (read: boolean, ids?: string[]) => void;
  applyLabelToggle: (labelGmailId: string, ids?: string[]) => void;
  undo: () => void;
  fileUnder: (category: CategoryId | null, ids?: string[]) => void;
  /** The gesture: flip the cursor's (or selection's) threads between
   *  Important and Other, or set them to `important`. */
  markImportant: (important?: boolean, ids?: string[]) => void;
  snooze: (until: number, ids?: string[]) => void;
  watchReply: (until: number, ids?: string[]) => void;
  unRemind: (ids?: string[]) => void;
  sweepAct: (action: "archive" | "trash" | "open") => void;
  /** The piles the sweep shows in its current mode. */
  sweepPiles: () => Pile[];
  /** The pile under the sweep cursor. */
  sweepFocused: () => Pile | null;
  /** Move the targeted threads into a topic (null = out of every topic). */
  moveToTopic: (clusterId: string | null, ids?: string[]) => void;
  /** Make a new topic from the targeted threads. */
  newTopicFrom: (name: string, ids?: string[]) => void;

  // ——— AI gestures (async; resolve through the aiBridge seam) ———
  summarizeThread: (threadRowId?: string) => void;
  aiDraftReply: (instruction?: string) => void;

  // ——— compose ———
  startCompose: (mode: ComposeMode, baseThreadGmailId?: string) => void;
  updateComposeDraft: (fields: Partial<Draft>) => void;
  sendCompose: () => void;
  discardCompose: () => void;
  minimizeCompose: (min: boolean) => void;
  setComposeHeadOpen: (open: boolean) => void;

  // ——— attachments ———
  /** Open the viewer on one file; with no arguments, on the first file of
   *  the focused message (or the first message that has any). */
  openAttachment: (messageGmailId?: string, index?: number) => void;
  /** Step to the next or previous file across the open thread. */
  moveAttachment: (delta: number) => void;
  closeAttachment: () => void;
};

let toastSeq = 1;

function newClientId(): string {
  return `draft-${platformEnv().uuid()}`;
}

/** Targets of a mail gesture: explicit ids, else selection, else focus. A
 *  topic row under the cursor stands for every conversation in it, so `e`
 *  on "Sentry Alerts" archives the whole topic. */
function targetIds(s: MailState, ids?: string[]): string[] {
  if (ids) return ids;
  const sel = Object.keys(s.selected);
  if (sel.length > 0) return sel;
  return s.focusedThreadId ? rowThreadIds(s, s.focusedThreadId) : [];
}

function isGroupRow(id: string | null | undefined): boolean {
  return !!id && id.startsWith(TOPIC_ROW);
}

function rowsByIds(s: MailState, ids: string[]): Thread[] {
  return ids.map((id) => s.threads[id]).filter(Boolean);
}

/** The address the person chose for new mail in Settings, while its mailbox
 *  is connected and may still send as it. */
export function defaultFrom(s: {
  accounts: Record<string, Account>;
  clientState: Record<string, any>;
}): { account: Account; email: string } | null {
  const pick = clientPref<{ account_id?: string; email?: string }>(s, "send_from");
  const account = pick?.account_id ? s.accounts[pick.account_id] : undefined;
  return account && pick?.email && isOwnAddress(account, pick.email) ? { account, email: pick.email } : null;
}

/** The account new mail sends from under the current scope: the scoped one,
 *  else the one holding the default address, else the primary (first-attached). */
export function scopedAccount(s: {
  accountScope: AccountScope;
  accounts: Record<string, Account>;
  clientState: Record<string, any>;
}): Account | null {
  if (s.accountScope !== "all" && s.accounts[s.accountScope]) {
    return s.accounts[s.accountScope];
  }
  return defaultFrom(s)?.account ?? (orderedAccounts(s.accounts)[0] as Account | undefined) ?? null;
}

/** One op per account — a gesture in the unified view can span mailboxes, and
 *  each account's changes must reach its own Gmail. */
function opsByAccount(rows: Thread[], add: string[], remove: string[]): ThreadOp[] {
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const list = groups.get(r.account_id) ?? [];
    list.push(r.gmail_id);
    groups.set(r.account_id, list);
  }
  return [...groups.entries()].map(([account_id, thread_gmail_ids]) => ({
    thread_gmail_ids,
    add_label_ids: add,
    remove_label_ids: remove,
    account_id,
  }));
}

/** Recompute derived flags after label surgery. Deliberately does NOT touch
 *  updated_at: the server owns that stamp, and an optimistic value would sit
 *  behind a pending lock that no echo could ever match. */
function applyLabelChange(t: Thread, add: string[], remove: string[]): void {
  const set = new Set(t.label_ids);
  for (const l of remove) set.delete(l);
  for (const l of add) set.add(l);
  // Sort for a canonical order: the pending lock retires by value equality
  // with the server echo, and Gmail returns label ids in its own order.
  t.label_ids = [...set].sort();
  t.is_unread = set.has(L.UNREAD);
  t.is_starred = set.has(L.STARRED);
}

/** Where the cursor should land after rows leave the current view. Walks the
 *  view's row ids, so it serves drafts (client ids) as well as threads. */
function nextFocusAfterRemoval(s: MailState, leavingIds: Set<string>): string | null {
  const vis = visibleRowIds(s);
  // A topic row with conversations left after the gesture is still there.
  if (isGroupRow(s.focusedThreadId) && rowThreadIds(s, s.focusedThreadId!).some((id) => !leavingIds.has(id))) return s.focusedThreadId;
  const idx = vis.indexOf(s.focusedThreadId ?? "");
  if (idx === -1) return vis.find((id) => !leavingIds.has(id)) ?? null;
  for (let i = idx + 1; i < vis.length; i++) {
    if (!leavingIds.has(vis[i])) return vis[i];
  }
  for (let i = idx - 1; i >= 0; i--) {
    if (!leavingIds.has(vis[i])) return vis[i];
  }
  return null;
}

const creator = (set: any, get: any) => ({
  accounts: {},
  labels: {},
  calendars: {},
  events: {},
  calendarReady: false,
  calendarSyncError: null,
  calendarOpenId: null,
  calendarDialogOpen: false,
  setCalendarState: (state: Partial<MailState>) => set(state),
  pruneCalendarAccounts: (ids: string[]) => {
    const state = get() as MailState;
    const roster = new Set(ids);
    set({
      calendars: Object.fromEntries(Object.entries(state.calendars).filter(([, row]) => roster.has(row.account_id))),
      events: Object.fromEntries(Object.entries(state.events).filter(([, row]) => roster.has(row.account_id))),
      calendarOpenId: state.calendarOpenId && roster.has(state.events[state.calendarOpenId]?.account_id ?? "") ? state.calendarOpenId : null,
    });
  },
  threads: {},
  threadMessages: {},
  drafts: {},
  memories: {},
  reminders: {},
  clusters: {},
  filters: {},
  clientState: {},
  pending: {},
  syncMeta: {},

  authToken: null,
  accountScope: "all" as AccountScope,
  activeView: "inbox" as ViewId,
  lastNonSearchView: "inbox" as ViewId,
  focusedThreadId: null,
  openThreadId: null,
  soloThreadId: null,
  selected: {},
  searchOpen: false,
  searchQuery: "",
  searchStatus: "idle" as const,
  searchHits: [] as string[],
  searchCursor: null as string | null,
  searchHasMore: false,
  msgExpanded: {} as Record<string, boolean>,
  msgFocusId: null as string | null,
  navOpen: false,
  paletteOpen: false,
  helpOpen: false,
  labelPickerOpen: false,
  categoryPickerOpen: false,
  timePicker: null as "snooze" | "followup" | null,
  memoriesOpen: false,
  settingsOpen: false,
  sweepIndex: 0,
  sweepFocusId: null as string | null,
  clusterPickerOpen: false,
  filtersOpen: false,
  threadSummaries: {} as Record<
    string,
    { status: "loading" | "done" | "error"; text?: string }
  >,
  composeAiBusy: false,
  composeDraftId: null,
  composeMinimized: false,
  composeHeadOpen: false,
  attachmentViewer: null as { messageGmailId: string; index: number } | null,
  pendingKeys: [] as string[],
  toasts: [] as Toast[],
  undoStack: [] as UndoEntry[],
  hydrated: false,

  // ————— server-dispatched actions —————

  // The one primitive every mail gesture compiles to. Local rows mutate here
  // (optimistic, pending-protected); the server side effect of the same name
  // receives `ops` and mirrors the change into Convex + the Gmail op queue.
  applyThreadOps: action(function (this: MailState, payload: { ops: ThreadOp[] }, undoLabel?: string | null) {
    const ops = payload.ops;
    for (const op of ops) {
      const targets = new Set(op.thread_gmail_ids);
      for (const id in this.threads) {
        const t = this.threads[id];
        // gmail ids are only unique within one mailbox; respect the op's account.
        if (targets.has(t.gmail_id) && (!op.account_id || t.account_id === op.account_id)) {
          applyLabelChange(t, op.add_label_ids, op.remove_label_ids);
        }
      }
      // Keep open-thread messages consistent (read state renders per message).
      for (const gid of op.thread_gmail_ids) {
        const msgs = this.threadMessages[gid];
        if (!msgs) continue;
        if (op.remove_label_ids.includes(L.UNREAD)) {
          for (const m of msgs) m.is_unread = false;
        }
      }
    }
    if (undoLabel) {
      const inverse: ThreadOp[] = ops.map((op) => ({
        thread_gmail_ids: op.thread_gmail_ids,
        add_label_ids: op.remove_label_ids,
        remove_label_ids: op.add_label_ids,
        account_id: op.account_id,
      }));
      this.undoStack = [...this.undoStack.slice(-19), { label: undoLabel, ops: inverse }];
      const id = toastSeq++;
      this.toasts = [
        ...this.toasts.filter((t) => t.kind !== "undo"),
        { id, text: undoLabel, kind: "undo" as const, expiresAt: Date.now() + 5000 },
      ];
    }
  }),

  sendMessage: action(function (this: MailState, payload: SendPayload) {
    const clientId = payload.client_id;
    const draft = payload;
    if (draft.to.length === 0) return;
    const acct =
      (payload.account_id && this.accounts[payload.account_id]) ||
      scopedAccount(this);
    const me: Address = acct ? fromAddress(acct, payload.from) : { email: "me" };
    const now = Date.now();
    // Mirror the server's id conventions exactly (dispatch.ts sendMessage) so
    // the optimistic rows supersede cleanly: thread gmail id, message gmail id,
    // and the thread's client_id all match what the server will echo.
    const threadGmailId = draft.thread_gmail_id ?? `local-thread-${clientId}`;
    const optimistic: Message = {
      _id: `local-msg-${clientId}`,
      account_id: acct?._id ?? "",
      thread_gmail_id: threadGmailId,
      gmail_id: `local-msg-${clientId}`,
      from: me,
      to: draft.to,
      cc: draft.cc.length ? draft.cc : undefined,
      date: now,
      snippet: draft.body_text.slice(0, 120),
      body_text: draft.body_text,
      label_ids: [L.SENT],
      is_unread: false,
      attachments: outgoingAsAttachments(draft.attachments),
      updated_at: now,
    };
    const existing = this.threadMessages[threadGmailId];
    this.threadMessages = {
      ...this.threadMessages,
      [threadGmailId]: existing ? [...existing, optimistic] : [optimistic],
    };
    // Bump or create the thread row optimistically.
    let threadRow: Thread | undefined;
    for (const id in this.threads) {
      if (this.threads[id].gmail_id === threadGmailId) threadRow = this.threads[id];
    }
    if (threadRow) {
      // Reply into an existing thread. Do NOT write last_at / updated_at /
      // message_count here: the server owns those stamps (recomputeThread), and
      // an optimistic value would sit behind a pending lock no echo can match,
      // freezing the row. The reply is visible in the open thread immediately
      // via threadMessages; the list row re-sorts on the server echo (fast).
      // Only the SENT label is a real, matchable change — add it sorted so its
      // lock retires against the server's canonical order.
      applyLabelChange(threadRow, [L.SENT], []);
    } else {
      // New thread. The stub carries client_id so the threads altKey supersede
      // rekeys it onto the server row; its gmail_id already matches, so the
      // message detail cache and open-thread subscription line up with no
      // orphaned rows.
      this.threads[clientId] = {
        _id: clientId,
        account_id: acct?._id ?? "",
        gmail_id: threadGmailId,
        client_id: clientId,
        subject: draft.subject || "(no subject)",
        snippet: draft.body_text.slice(0, 120),
        participants: [me, ...draft.to],
        message_count: 1,
        last_at: now,
        label_ids: [L.SENT],
        is_unread: false,
        is_starred: false,
        has_attachments: optimistic.attachments.length > 0,
        updated_at: now,
      };
    }
    delete this.drafts[clientId];
    if (this.composeDraftId === clientId) {
      this.composeDraftId = null;
      this.composeMinimized = false;
    }
    const id = toastSeq++;
    this.toasts = [...this.toasts, { id, text: "Sent", kind: "info" as const, expiresAt: Date.now() + 2500 }];
  }),

  saveDraft: action(function (this: MailState, draft: Draft) {
    this.drafts[draft.client_id] = { ...draft, updated_at: Date.now() };
  }),

  deleteDraft: action(function (this: MailState, payload: { client_id: string }) {
    delete this.drafts[payload.client_id];
    if (this.composeDraftId === payload.client_id) {
      this.composeDraftId = null;
      this.composeMinimized = false;
    }
  }),

  setClientPref: action(function (this: MailState, key: string, value: any) {
    applyClientPref(this, key, value);
  }),

  // A correction. The named threads are the user's word (final); with
  // `remember` the same sender's other mail re-files locally right now, the
  // way the server side effect will — one gesture moves the whole pile.
  setCategory: action(function (
    this: MailState,
    payload: {
      thread_gmail_ids: string[];
      category: CategoryId | null;
      account_id?: string;
      remember?: boolean;
    },
  ) {
    const targets = new Set(payload.thread_gmail_ids);
    const category = payload.category ?? undefined;
    const senders = new Set<string>();
    for (const id in this.threads) {
      const t = this.threads[id];
      if (!targets.has(t.gmail_id)) continue;
      if (payload.account_id && t.account_id !== payload.account_id) continue;
      t.category = category;
      t.category_source = "user";
      const me = this.accounts[t.account_id];
      const sender = t.participants.find((p) => !me || !isOwnAddress(me, p.email));
      if (sender) senders.add(`${t.account_id}:${sender.email.toLowerCase()}`);
    }
    if (payload.remember === false || senders.size === 0) return;
    // Mirror the server sweep exactly: only threads the sender STARTED move.
    for (const id in this.threads) {
      const t = this.threads[id];
      if (targets.has(t.gmail_id) || t.category_source === "user") continue;
      const starter = t.participants[0];
      if (!starter) continue;
      if (!senders.has(`${t.account_id}:${starter.email.toLowerCase()}`)) continue;
      if (t.category === category) continue;
      t.category = category;
      t.category_source = "rule";
    }
  }),

  setImportance: action(function (
    this: MailState,
    payload: { thread_gmail_ids: string[]; important: boolean | null; account_id?: string },
  ) {
    const targets = new Set(payload.thread_gmail_ids);
    for (const id in this.threads) {
      const t = this.threads[id];
      if (!targets.has(t.gmail_id)) continue;
      if (payload.account_id && t.account_id !== payload.account_id) continue;
      t.important = payload.important ?? undefined;
      t.important_by = payload.important === null ? undefined : "user";
      t.important_why = undefined;
    }
  }),

  setImportancePolicy: action(function (this: MailState, payload: { policy: string }) {
    const prev = clientPref<ImportancePrefs>(this, "importance");
    const policy = payload.policy.trim() === DEFAULT_IMPORTANCE_POLICY ? undefined : payload.policy.trim();
    applyClientPref(this, "importance", { policy, revision: importanceRevision(prev) + 1 });
  }),

  setReminder: action(function (
    this: MailState,
    payload: {
      thread_gmail_id: string;
      kind: "snooze" | "followup";
      remind_at: number;
      account_id?: string;
    },
  ) {
    // The felt effect of a snooze is "gone from the inbox NOW"; the reminder
    // row itself arrives on the server echo (sub-second).
    if (payload.kind !== "snooze") return;
    for (const id in this.threads) {
      const t = this.threads[id];
      if (
        t.gmail_id === payload.thread_gmail_id &&
        (!payload.account_id || t.account_id === payload.account_id)
      ) {
        applyLabelChange(t, [], [L.INBOX]);
      }
    }
  }),

  cancelReminder: action(function (
    this: MailState,
    payload: { thread_gmail_id: string; account_id?: string },
  ) {
    for (const id in this.reminders) {
      const r = this.reminders[id];
      if (r.thread_gmail_id !== payload.thread_gmail_id) continue;
      if (payload.account_id && r.account_id !== payload.account_id) continue;
      if (r.status === "armed") {
        if (r.kind === "snooze") {
          for (const tid in this.threads) {
            const t = this.threads[tid];
            if (t.gmail_id === r.thread_gmail_id && t.account_id === r.account_id) {
              applyLabelChange(t, [L.INBOX], []);
            }
          }
        }
        r.status = "canceled";
      } else if (r.status === "fired") {
        r.status = "resolved";
      }
    }
  }),

  addMemory: action(function (
    this: MailState,
    _payload: { text: string; contact_email?: string },
  ) {
    // No optimistic row — the id is server-minted and the echo is fast.
  }),

  deleteMemory: action(function (this: MailState, payload: { memory_id: string }) {
    const m = this.memories[payload.memory_id];
    if (m) m.deleted = true;
  }),

  // ————— topics —————
  // Rows are server-minted; a new topic arrives on the echo. Everything
  // else mutates the local rows the way the side effect will.
  createCluster: action(function (
    this: MailState,
    _payload: { name: string; description?: string; thread_gmail_ids?: string[]; account_id?: string },
  ) {}),

  renameCluster: action(function (
    this: MailState,
    payload: { cluster_id: string; name?: string; description?: string; parent_id?: string | null; account_id?: string },
  ) {
    const c = this.clusters[payload.cluster_id];
    if (!c) return;
    if (payload.name !== undefined) c.name = payload.name;
    if (payload.description !== undefined) c.description = payload.description;
    if (payload.parent_id !== undefined) c.parent_id = payload.parent_id ?? undefined;
    c.source = "user";
  }),

  mergeClusters: action(function (
    this: MailState,
    payload: { from_ids: string[]; into_id: string; account_id?: string },
  ) {
    const into = this.clusters[payload.into_id];
    if (!into || into.deleted) throw new Error("That topic is gone — it was folded into another");
    const from = new Set(payload.from_ids.filter((id) => id !== payload.into_id));
    for (const id in this.threads) {
      const t = this.threads[id];
      if (t.cluster_id && from.has(t.cluster_id)) {
        t.cluster_id = payload.into_id;
        t.cluster_source = "user";
      }
    }
    for (const id in this.clusters) {
      const c = this.clusters[id];
      if (c.parent_id && from.has(c.parent_id)) c.parent_id = into.kind === "theme" ? payload.into_id : undefined;
    }
    for (const id of from) {
      const c = this.clusters[id];
      if (c) c.deleted = true;
    }
    into.source = "user";
  }),

  dissolveCluster: action(function (
    this: MailState,
    payload: { cluster_id: string; account_id?: string },
  ) {
    for (const id in this.threads) {
      const t = this.threads[id];
      if (t.cluster_id === payload.cluster_id) {
        t.cluster_id = undefined;
        t.cluster_source = "user";
      }
    }
    for (const id in this.clusters) {
      const c = this.clusters[id];
      if (c.parent_id === payload.cluster_id) c.parent_id = undefined;
    }
    const c = this.clusters[payload.cluster_id];
    if (c) c.deleted = true;
  }),

  setThreadCluster: action(function (
    this: MailState,
    payload: { thread_gmail_ids: string[]; cluster_id: string | null; account_id?: string },
  ) {
    const cluster = payload.cluster_id ? this.clusters[payload.cluster_id] : null;
    if (cluster) cluster.source = "user";
    const targets = new Set(payload.thread_gmail_ids);
    for (const id in this.threads) {
      const t = this.threads[id];
      if (!targets.has(t.gmail_id)) continue;
      if (payload.account_id && t.account_id !== payload.account_id) continue;
      t.cluster_id = payload.cluster_id ?? undefined;
      t.cluster_source = "user";
    }
  }),

  regroupClusters: action(function (
    this: MailState,
    payload: { fresh: boolean; account_id?: string },
  ) {
    void payload;
  }),

  // ————— sync recipes: platform engine applied to this store's draft —————
  syncTable: sync(function (this: MailState, field: string, incoming: any, opts?: any) {
    engine.syncTable(this, field, incoming, opts);
    // A topic folded away by the theme pass or another device leaves its
    // view with nothing to show; go back to the inbox.
    if (field === "clusters" && this.activeView.startsWith("cluster:")) {
      const id = this.activeView.slice("cluster:".length);
      if (id !== LOOSE_SECTION && (this.clusters[id]?.deleted || !this.clusters[id])) {
        this.activeView = "inbox";
        this.toasts = [...this.toasts, { id: toastSeq++, text: "That topic was folded into another", kind: "info", expiresAt: Date.now() + 3000 }];
      }
    }
  }),
  syncRecord: sync(function (this: MailState, field: string, id: string, record: any) {
    engine.syncRecord(this, field, id, record);
  }),
  syncDetail: sync(function (this: MailState, field: string, key: string, value: any) {
    const table = (this as any)[field] ?? {};
    // Optimistic sends live in the detail cache under client ids; a server
    // echo containing the same client_id supersedes them wholesale.
    (this as any)[field] = { ...table, [key]: value };
  }),

  // ————— local gestures —————

  setAuthToken: (token: string | null) => {
    platformEnv().saveToken(token);
    set({ authToken: token, ...(get().authToken !== token ? { calendars: {}, events: {}, calendarReady: false, calendarOpenId: null, calendarSyncError: null } : {}) });
  },
  setHydrated: () => set({ hydrated: true }),

  setView: (view: ViewId) => {
    const s = get();
    const isSearch = view.startsWith("search:");
    const vis = visibleRowIds({ ...s, activeView: view, searchHits: isSearch ? s.searchHits : [] });
    set({
      activeView: view,
      navOpen: false,
      lastNonSearchView: isSearch ? s.lastNonSearchView : view,
      openThreadId: null,
      selected: {},
      // The inline search bar belongs to the previous view; committing a search
      // sets a search: view (bar closes via commitSearch), and any other view
      // switch should close it too so reading keys stay live.
      searchOpen: false,
      // Remote hits belong to one committed query; leaving search drops them.
      ...(isSearch ? {} : { searchHits: [], searchStatus: "idle" as const, searchCursor: null, searchHasMore: false }),
      focusedThreadId:
        s.focusedThreadId && vis.includes(s.focusedThreadId)
          ? s.focusedThreadId
          : (vis[0] ?? null),
    });
  },

  setAccountScope: (scope: AccountScope) => {
    const s = get();
    if (scope !== "all" && !s.accounts[scope]) return;
    if (scope === s.accountScope) return set({ navOpen: false });
    const vis = visibleRowIds({ ...s, accountScope: scope });
    set({
      accountScope: scope,
      navOpen: false,
      openThreadId: null,
      selected: {},
      focusedThreadId:
        s.focusedThreadId && vis.includes(s.focusedThreadId)
          ? s.focusedThreadId
          : (vis[0] ?? null),
    });
  },

  focusThread: (id: string | null) => set({ focusedThreadId: id }),

  moveFocus: (delta: number) => {
    const s = get();
    // With a conversation open, j/k step between conversations; a topic row
    // is not something to read.
    const vis = s.openThreadId ? visibleRowIds(s).filter((id) => !isGroupRow(id)) : visibleRowIds(s);
    if (vis.length === 0) return;
    const idx = vis.indexOf(s.focusedThreadId ?? "");
    const next = idx === -1 ? (delta > 0 ? 0 : vis.length - 1) : Math.min(Math.max(idx + delta, 0), vis.length - 1);
    const target = vis[next];
    set({ focusedThreadId: target });
    // In thread view j/k walk the list too — keep the open thread in step.
    if (s.openThreadId) get().openThread(target);
  },

  focusEdge: (edge: "first" | "last") => {
    const s = get();
    const vis = visibleRowIds(s);
    if (vis.length === 0) return;
    const target = vis[edge === "first" ? 0 : vis.length - 1];
    set({ focusedThreadId: target });
    if (s.openThreadId) get().openThread(target);
  },

  openThread: (id: string | null, opts?: { solo?: boolean }) => {
    if (!id) return set({ openThreadId: null, soloThreadId: null });
    // A section head opens the topic's own page.
    if (isGroupRow(id)) return get().setView(`cluster:${id.slice(TOPIC_ROW.length)}`);
    const s = get();
    const t: Thread | undefined = s.threads[id];
    // Closing the search bar as we enter a thread keeps the key context honest:
    // a lingering open search surface would otherwise swallow all reading keys.
    // Message expansion and the n/p cursor are per-visit state.
    set({
      openThreadId: id,
      soloThreadId: opts?.solo ? id : null,
      focusedThreadId: id,
      searchOpen: false,
      msgExpanded: {},
      msgFocusId: null,
    });
    if (t?.is_unread) {
      get().applyThreadOps(
        { ops: [{ thread_gmail_ids: [t.gmail_id], add_label_ids: [], remove_label_ids: [L.UNREAD], account_id: t.account_id }] },
        null,
      );
    }
  },
  // Opening a draft IS opening compose on it — the Drafts row has no reader.
  // From the Drafts list the cursor follows; inside a thread it stays put.
  openDraft: (clientId: string) => {
    const s = get();
    if (!s.drafts[clientId]) return;
    set({
      ...(s.activeView === "drafts" ? { focusedThreadId: clientId } : {}),
      composeDraftId: clientId,
      composeMinimized: false,
    });
  },

  openFocused: () => {
    const s = get();
    if (!s.focusedThreadId) return;
    if (s.activeView === "drafts") get().openDraft(s.focusedThreadId);
    else get().openThread(s.focusedThreadId);
  },
  closeThread: () => set({ openThreadId: null, soloThreadId: null, attachmentViewer: null }),

  toggleSelect: (id?: string) => {
    const s = get();
    const target = id ?? s.focusedThreadId;
    if (!target) return;
    const selected = { ...s.selected };
    // A topic row selects or clears every conversation in it.
    const ids = rowThreadIds(s, target);
    const all = ids.every((t) => selected[t]);
    for (const t of ids) {
      if (all) delete selected[t];
      else selected[t] = true as const;
    }
    set({ selected });
  },

  // ————— the inbox as topics —————
  setInboxGrouped: (grouped: boolean) => {
    const s = get();
    applyClientPrefAndSave(get, "inbox", { grouped });
    // The cursor lands on the same conversation, or the top of the new list.
    const vis = visibleRowIds({ ...get() });
    const keep = s.focusedThreadId && vis.includes(s.focusedThreadId);
    set({ focusedThreadId: keep ? s.focusedThreadId : (vis[0] ?? null), selected: {} });
  },
  setClusterTreatment: action(function (
    this: MailState,
    payload: { cluster_id: string; hidden?: boolean; archive_new?: boolean; account_id?: string },
  ) {
    const c = this.clusters[payload.cluster_id];
    if (!c) return;
    if (payload.hidden !== undefined) c.hidden = payload.hidden;
    if (payload.archive_new !== undefined) c.archive_new_since = payload.archive_new ? (c.archive_new_since ?? Date.now()) : undefined;
    c.source = "user";
  }),
  /** Hide or unhide a topic. Hidden topics leave the inbox list, the unread
   *  count and notifications; their mail stays in the inbox and comes back
   *  with the section when the topic is unhidden. */
  hideTopic: (clusterId: string) => {
    const s = get();
    const c = s.clusters[clusterId];
    if (!c || c.deleted) return;
    const hide = !c.hidden;
    get().setClusterTreatment({ cluster_id: c._id, hidden: hide, archive_new: false, account_id: c.account_id });
    if (hide && s.activeView === "inbox") {
      const ids = topicPile(s.threads, s.clusters, s.accountScope, c._id)?.threads.map((t) => t._id) ?? [];
      const leaving = new Set(ids.concat(topicRowId(c._id)));
      if (s.focusedThreadId && leaving.has(s.focusedThreadId)) {
        set({ focusedThreadId: nextFocusAfterRemoval(s, leaving) });
      }
    }
    get().pushToast(hide ? `Hidden ${c.name}` : `${c.name} is back in the inbox`);
  },
  hideFocusedTopic: () => {
    const s = get();
    const id = s.focusedThreadId;
    if (!id) return;
    const clusterId = id.startsWith(TOPIC_ROW) ? id.slice(TOPIC_ROW.length) : s.threads[id]?.cluster_id;
    const c = shownTopic(clusterId ? s.clusters[clusterId] : undefined, s.clusters);
    if (!c) return get().pushToast("This conversation has no topic yet");
    get().hideTopic(c._id);
  },
  clearSelection: () => set({ selected: {} }),

  setSearch: (open: boolean, query?: string) =>
    set((s: MailState) => ({
      searchOpen: open,
      ...(open ? { navOpen: false } : {}),
      searchQuery: query !== undefined ? query : open ? s.searchQuery : "",
    })),
  commitSearch: () => {
    const s = get();
    const q = s.searchQuery.trim();
    if (!q) return set({ searchOpen: false });
    const view = `search:${q}` as ViewId;
    get().setView(view);
    // Local matches render instantly; the deep pass asks Gmail itself, one
    // page at a time, and its hits fold in as they land.
    set({
      searchOpen: false,
      searchQuery: q,
      searchStatus: "idle",
      searchHits: [],
      searchCursor: null,
      searchHasMore: true,
    });
    get().loadMoreSearch();
  },
  loadMoreSearch: () => {
    const s = get();
    const view = s.activeView;
    if (!view.startsWith("search:")) return;
    if (s.searchStatus === "searching" || !s.searchHasMore) return;
    const q = view.slice("search:".length);
    set({ searchStatus: "searching" });
    // Results only apply if this query is still the active view — a stale
    // response must not repaint a newer search.
    void remoteSearch(q, s.searchCursor)
      .then((page) => {
        if (get().activeView !== view) return;
        // Hits older than the synced window exist nowhere else on the client:
        // the rows ride with the result and land like any synced page.
        get().syncTable("threads", page.rows);
        const seen = new Set(get().searchHits);
        const hits = [...get().searchHits];
        for (const row of page.rows) {
          if (!seen.has(row.gmail_id)) {
            seen.add(row.gmail_id);
            hits.push(row.gmail_id);
          }
        }
        set({
          searchHits: hits,
          searchStatus: "idle",
          searchCursor: page.cursor,
          searchHasMore: page.cursor !== null,
        });
        // A cursor that was empty (no local match) lands on the first hit.
        const cur = get();
        const vis = visibleRowIds(cur);
        if (!cur.focusedThreadId && vis[0]) set({ focusedThreadId: vis[0] });
        // Keep paging on our own until the list fills a screen; past that the
        // reader scrolls for more.
        if (cur.searchHasMore && vis.length < SEARCH_PAGE_FILL) get().loadMoreSearch();
      })
      .catch(() => {
        if (get().activeView !== view) return;
        set({ searchStatus: "idle", searchHasMore: false });
        get().pushToast("Full search failed — showing local matches", "error");
      });
  },

  moveMsgFocus: (delta: number) => {
    const s = get();
    const t = s.openThreadId ? s.threads[s.openThreadId] : null;
    const msgs: Message[] = t ? (s.threadMessages[t.gmail_id] ?? []) : [];
    if (msgs.length === 0) return;
    const idx = msgs.findIndex((m) => m.gmail_id === s.msgFocusId);
    // No cursor yet: the reader is looking at the newest message.
    const from = idx === -1 ? msgs.length - 1 : idx;
    const next = Math.min(Math.max(from + delta, 0), msgs.length - 1);
    const target = msgs[next];
    // Walking onto a message opens it — n/p reads through the conversation.
    set({
      msgFocusId: target.gmail_id,
      msgExpanded: { ...s.msgExpanded, [target.gmail_id]: true },
    });
  },

  toggleMsgExpanded: (gmailId?: string) => {
    const s = get();
    const t = s.openThreadId ? s.threads[s.openThreadId] : null;
    const msgs: Message[] = t ? (s.threadMessages[t.gmail_id] ?? []) : [];
    if (msgs.length === 0) return;
    const id = gmailId ?? s.msgFocusId ?? msgs[msgs.length - 1].gmail_id;
    const idx = msgs.findIndex((m) => m.gmail_id === id);
    if (idx === -1) return;
    const effective =
      s.msgExpanded[id] ?? msgExpandedDefault(msgs[idx], idx, msgs.length);
    set({
      msgFocusId: id,
      msgExpanded: { ...s.msgExpanded, [id]: !effective },
    });
  },

  setAllMsgExpanded: (open: boolean) => {
    const s = get();
    const t = s.openThreadId ? s.threads[s.openThreadId] : null;
    const msgs = t ? (s.threadMessages[t.gmail_id] ?? []) : [];
    if (msgs.length === 0) return;
    const msgExpanded: Record<string, boolean> = {};
    for (const m of msgs) msgExpanded[m.gmail_id] = open;
    set({ msgExpanded });
  },

  setNav: (open: boolean) => set({ navOpen: open }),
  setPalette: (open: boolean) => set({ paletteOpen: open }),
  setHelp: (open: boolean) => set({ helpOpen: open }),
  setLabelPicker: (open: boolean) => set({ labelPickerOpen: open }),
  setCategoryPicker: (open: boolean) => set({ categoryPickerOpen: open }),
  setTimePicker: (mode: "snooze" | "followup" | null) => set({ timePicker: mode }),
  setMemories: (open: boolean) => set({ memoriesOpen: open }),
  setSettings: (open: boolean) => set({ settingsOpen: open, ...(open ? { navOpen: false } : {}) }),
  setSweepFocus: (id: string, index: number) => set({ sweepFocusId: id, sweepIndex: index }),
  setClusterPicker: (open: boolean) => set({ clusterPickerOpen: open }),
  setFilters: (open: boolean) => set({ filtersOpen: open }),
  sweepPiles: () => {
    const s = get();
    return inboxClusters(s.threads, s.accountScope);
  },
  // The cursor follows a pile by id, so a list that re-sorts under it (a
  // pass landing, mail arriving) never swaps the card that `e` archives.
  // The index is the fallback for a pile that is gone.
  sweepFocused: () => {
    const s = get();
    const piles = s.sweepPiles();
    const byId = s.sweepFocusId ? piles.find((p: Pile) => p.meta.id === s.sweepFocusId) : undefined;
    return byId ?? piles[Math.min(s.sweepIndex, piles.length - 1)] ?? null;
  },
  moveSweep: (delta: number) => {
    const s = get();
    const piles = s.sweepPiles();
    if (piles.length === 0) return set({ sweepIndex: 0, sweepFocusId: null });
    const current = s.sweepFocusId ? piles.findIndex((p: Pile) => p.meta.id === s.sweepFocusId) : -1;
    const from = current >= 0 ? current : Math.min(s.sweepIndex, piles.length - 1);
    const next = Math.min(Math.max(from + delta, 0), piles.length - 1);
    set({ sweepIndex: next, sweepFocusId: piles[next].meta.id });
  },
  setPendingKeys: (keys: string[]) => set({ pendingKeys: keys }),

  dismissToast: (id: number) => set((s: MailState) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  pushToast: (text: string, kind: Toast["kind"] = "info") =>
    set((s: MailState) => ({
      toasts: [...s.toasts, { id: toastSeq++, text, kind, expiresAt: Date.now() + 3000 }],
    })),

  // ————— high-level mail gestures —————

  archive: (ids?: string[]) => {
    const s = get();
    const rows = rowsByIds(s, targetIds(s, ids));
    if (rows.length === 0) return;
    const leaving = new Set(rows.map((r) => r._id));
    const next = nextFocusAfterRemoval(s, leaving);
    get().applyThreadOps(
      { ops: opsByAccount(rows, [], [L.INBOX]) },
      rows.length === 1 ? "Archived" : `Archived ${rows.length} conversations`,
    );
    set({ selected: {}, focusedThreadId: next, openThreadId: s.openThreadId ? next : null });
  },

  trash: (ids?: string[]) => {
    const s = get();
    // In Drafts the cursor holds a draft client id, and "delete" means discard
    // the draft — there is no thread to relabel.
    if (s.activeView === "drafts") {
      const id = ids?.[0] ?? s.focusedThreadId;
      if (!id || !s.drafts[id]) return;
      const next = nextFocusAfterRemoval(s, new Set([id]));
      get().deleteDraft({ client_id: id });
      set({ focusedThreadId: next });
      get().pushToast("Draft discarded");
      return;
    }
    const rows = rowsByIds(s, targetIds(s, ids));
    if (rows.length === 0) return;
    const leaving = new Set(rows.map((r) => r._id));
    const next = nextFocusAfterRemoval(s, leaving);
    get().applyThreadOps(
      { ops: opsByAccount(rows, [L.TRASH], [L.INBOX]) },
      rows.length === 1 ? "Moved to trash" : `Trashed ${rows.length} conversations`,
    );
    set({ selected: {}, focusedThreadId: next, openThreadId: s.openThreadId ? next : null });
  },

  markSpam: (ids?: string[]) => {
    const s = get();
    const rows = rowsByIds(s, targetIds(s, ids));
    if (rows.length === 0) return;
    const leaving = new Set(rows.map((r) => r._id));
    const next = nextFocusAfterRemoval(s, leaving);
    get().applyThreadOps(
      { ops: opsByAccount(rows, [L.SPAM], [L.INBOX]) },
      "Marked as spam",
    );
    set({ selected: {}, focusedThreadId: next, openThreadId: s.openThreadId ? next : null });
  },

  toggleStar: (id?: string) => {
    const s = get();
    // Honor selection like the other row actions (was focus-only). With a
    // mixed selection, star all unless every target is already starred.
    const rows = id ? rowsByIds(s, [id]) : rowsByIds(s, targetIds(s));
    if (rows.length === 0) return;
    const allStarred = rows.every((r) => r.is_starred);
    get().applyThreadOps(
      {
        ops: opsByAccount(
          rows,
          allStarred ? [] : [L.STARRED],
          allStarred ? [L.STARRED] : [],
        ),
      },
      rows.length > 1 ? (allStarred ? "Unstarred" : "Starred") : null,
    );
  },

  setRead: (read: boolean, ids?: string[]) => {
    const s = get();
    const rows = rowsByIds(s, targetIds(s, ids));
    if (rows.length === 0) return;
    get().applyThreadOps(
      {
        ops: opsByAccount(
          rows,
          read ? [] : [L.UNREAD],
          read ? [L.UNREAD] : [],
        ),
      },
      null,
    );
    set({ selected: {} });
  },

  applyLabelToggle: (labelGmailId: string, ids?: string[]) => {
    const s = get();
    const rows = rowsByIds(s, targetIds(s, ids));
    if (rows.length === 0) return;
    const allHave = rows.every((r) => r.label_ids.includes(labelGmailId));
    get().applyThreadOps(
      {
        ops: opsByAccount(
          rows,
          allHave ? [] : [labelGmailId],
          allHave ? [labelGmailId] : [],
        ),
      },
      allHave ? "Label removed" : "Label applied",
    );
  },

  undo: () => {
    const s = get();
    const entry = s.undoStack[s.undoStack.length - 1];
    if (!entry) return;
    set({
      undoStack: s.undoStack.slice(0, -1),
      toasts: s.toasts.filter((t: Toast) => t.kind !== "undo"),
    });
    get().applyThreadOps({ ops: entry.ops }, null);
    get().pushToast("Undone");
  },

  fileUnder: (category: CategoryId | null, ids?: string[]) => {
    const s = get();
    const rows = rowsByIds(s, targetIds(s, ids));
    if (rows.length === 0) return;
    // Filing can empty the row's place in a lane view; keep the cursor seated.
    const leavesView = s.activeView.startsWith("cat:");
    const next = leavesView
      ? nextFocusAfterRemoval(s, new Set(rows.map((r) => r._id)))
      : s.focusedThreadId;
    // One dispatch per account, like every unified-view gesture.
    const byAccount = new Map<string, string[]>();
    for (const r of rows) {
      const list = byAccount.get(r.account_id) ?? [];
      list.push(r.gmail_id);
      byAccount.set(r.account_id, list);
    }
    for (const [account_id, thread_gmail_ids] of byAccount) {
      get().setCategory({ thread_gmail_ids, category, account_id });
    }
    const name = category ? (categoryMeta(category)?.name ?? category) : "Primary";
    get().pushToast(
      category
        ? `Filed under ${name} — Whisk will remember`
        : `Moved to Primary — Whisk will remember`,
    );
    set({
      selected: {},
      focusedThreadId: next,
      ...(leavesView && s.openThreadId ? { openThreadId: next } : {}),
    });
  },

  markImportant: (important?: boolean, ids?: string[]) => {
    const s = get();
    const rows = rowsByIds(s, targetIds(s, ids));
    if (rows.length === 0) return;
    // One verdict for the whole gesture: an explicit one, else the flip of
    // the first row, so a mixed selection lands in one place.
    const next = important ?? rows[0].important === false;
    const leaving = rows.filter((r) => (s.activeView === "inbox" && !next) || (s.activeView === "other" && next));
    const focus = leaving.length > 0 ? nextFocusAfterRemoval(s, new Set(leaving.map((r) => r._id))) : s.focusedThreadId;
    const byAccount = new Map<string, string[]>();
    for (const r of rows) byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r.gmail_id]);
    for (const [account_id, thread_gmail_ids] of byAccount) get().setImportance({ thread_gmail_ids, important: next, account_id });
    const n = rows.length === 1 ? "" : `${rows.length} `;
    get().pushToast(next ? `Moved ${n}to Important` : `Moved ${n}to Other`);
    set({
      selected: {},
      focusedThreadId: focus,
      ...(leaving.length > 0 && s.openThreadId && leaving.some((r) => r._id === s.openThreadId) ? { openThreadId: focus } : {}),
    });
  },

  snooze: (until: number, ids?: string[]) => {
    const s = get();
    const rows = rowsByIds(s, targetIds(s, ids));
    if (rows.length === 0) return;
    const leaving = new Set(rows.map((r) => r._id));
    const next = nextFocusAfterRemoval(s, leaving);
    for (const r of rows) {
      get().setReminder({
        thread_gmail_id: r.gmail_id,
        kind: "snooze",
        remind_at: until,
        account_id: r.account_id,
      });
    }
    const when = new Date(until).toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
    get().pushToast(
      rows.length === 1 ? `Snoozed until ${when}` : `Snoozed ${rows.length} until ${when}`,
    );
    set({ selected: {}, focusedThreadId: next, openThreadId: s.openThreadId ? next : null });
  },

  watchReply: (until: number, ids?: string[]) => {
    const s = get();
    const rows = rowsByIds(s, targetIds(s, ids));
    if (rows.length === 0) return;
    for (const r of rows) {
      get().setReminder({
        thread_gmail_id: r.gmail_id,
        kind: "followup",
        remind_at: until,
        account_id: r.account_id,
      });
    }
    get().pushToast("Watching — Whisk nudges you if nobody replies");
    set({ selected: {} });
  },

  unRemind: (ids?: string[]) => {
    const s = get();
    const rows = rowsByIds(s, targetIds(s, ids));
    if (rows.length === 0) return;
    const inLater = s.activeView === "later" || s.activeView === "waiting";
    const next = inLater
      ? nextFocusAfterRemoval(s, new Set(rows.map((r) => r._id)))
      : s.focusedThreadId;
    for (const r of rows) {
      get().cancelReminder({ thread_gmail_id: r.gmail_id, account_id: r.account_id });
    }
    get().pushToast("Reminder cleared");
    set({ selected: {}, focusedThreadId: next });
  },

  sweepAct: (action: "archive" | "trash" | "open") => {
    const cluster = get().sweepFocused();
    if (!cluster) return;
    if (action === "open") {
      get().setView(cluster.meta.view);
      return;
    }
    const ids = cluster.threads.map((t: Thread) => t._id);
    if (action === "archive") get().archive(ids);
    else get().trash(ids);
    // The card under the cursor vanished; stay clamped on the survivors.
    get().moveSweep(0);
  },

  moveToTopic: (clusterId: string | null, ids?: string[]) => {
    const s = get();
    const rows = rowsByIds(s, targetIds(s, ids));
    if (rows.length === 0) return;
    const target = clusterId ? s.clusters[clusterId] : null;
    if (clusterId && (!target || target.deleted)) {
      get().pushToast("That topic is gone — it was folded into another", "error");
      return;
    }
    if (target && rows.some(r => r.account_id !== target.account_id)) {
      get().pushToast("Choose threads from the topic’s mailbox", "error");
      return;
    }
    // Rows already where they are asked to go do not move, and a gesture
    // that moves nothing says nothing.
    const moving = rows.filter((r) => (r.cluster_id ?? null) !== clusterId);
    if (moving.length === 0) return;
    const leavesView = s.activeView.startsWith("cluster:");
    const next = leavesView
      ? nextFocusAfterRemoval(s, new Set(moving.map((r) => r._id)))
      : s.focusedThreadId;
    const byAccount = new Map<string, string[]>();
    for (const r of moving) {
      byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r.gmail_id]);
    }
    for (const [account_id, thread_gmail_ids] of byAccount) {
      get().setThreadCluster({ thread_gmail_ids, cluster_id: clusterId, account_id });
    }
    get().pushToast(target ? `Moved to ${target.name}` : "Removed from its topic");
    set({
      selected: {},
      focusedThreadId: next,
      ...(leavesView && s.openThreadId ? { openThreadId: next } : {}),
    });
  },

  newTopicFrom: (name: string, ids?: string[]) => {
    const s = get();
    const rows = rowsByIds(s, targetIds(s, ids));
    const trimmed = name.trim();
    if (!trimmed) return;
    const account_id = rows[0]?.account_id ?? scopedAccount(s)?._id;
    if (!account_id) return;
    if (rows.some(r => r.account_id !== account_id)) {
      get().pushToast("Choose conversations from one mailbox", "error");
      return;
    }
    get().createCluster({
      name: trimmed,
      thread_gmail_ids: rows.filter((r) => r.account_id === account_id).map((r) => r.gmail_id),
      account_id,
    });
    get().pushToast(`New topic: ${trimmed}`);
    set({ selected: {} });
  },

  // ————— AI gestures —————

  summarizeThread: (threadRowId?: string) => {
    const s = get();
    const rowId = threadRowId ?? s.openThreadId;
    const t = rowId ? s.threads[rowId] : null;
    if (!t) return;
    const existing = s.threadSummaries[t.gmail_id];
    if (existing?.status === "loading") return;
    if (existing?.status === "done") {
      // Toggle off — the card leaves; the server cache keeps the text.
      const rest = { ...s.threadSummaries };
      delete rest[t.gmail_id];
      set({ threadSummaries: rest });
      return;
    }
    if (!aiAvailable()) {
      get().pushToast("AI is not available in this session", "error");
      return;
    }
    set({
      threadSummaries: {
        ...s.threadSummaries,
        [t.gmail_id]: { status: "loading" as const },
      },
    });
    void aiClient()
      .summarizeThread({ threadGmailId: t.gmail_id, accountId: t.account_id })
      .then(({ summary }) => {
        set({
          threadSummaries: {
            ...get().threadSummaries,
            [t.gmail_id]: { status: "done" as const, text: summary },
          },
        });
      })
      .catch(() => {
        const rest = { ...get().threadSummaries };
        delete rest[t.gmail_id];
        set({ threadSummaries: rest });
        get().pushToast("Summary failed", "error");
      });
  },

  aiDraftReply: (instruction?: string) => {
    const s = get();
    const t = s.openThreadId ? s.threads[s.openThreadId] : null;
    if (!t) return;
    if (!aiAvailable()) {
      get().pushToast("AI is not available in this session", "error");
      return;
    }
    // The compose opens NOW (empty, marked busy); the words arrive when ready.
    if (!s.composeDraftId) get().startCompose("reply", t.gmail_id);
    const draftId = get().composeDraftId;
    if (!draftId) return;
    set({ composeAiBusy: true });
    void aiClient()
      .draftReply({
        threadGmailId: t.gmail_id,
        accountId: t.account_id,
        instruction,
      })
      .then(({ body_text }) => {
        const cur = get();
        // Fill only if this compose is still the one we started.
        if (cur.composeDraftId === draftId) {
          cur.updateComposeDraft({ body_text });
        }
      })
      .catch(() => get().pushToast("Draft failed", "error"))
      .finally(() => set({ composeAiBusy: false }));
  },

  // ————— compose —————

  startCompose: (mode: ComposeMode, baseThreadGmailId?: string) => {
    const s = get();
    // A conversation holds one reply and one forward in progress: starting
    // either again picks up the draft already there, wherever it was written.
    if (mode !== "new" && baseThreadGmailId) {
      const forward = mode === "forward";
      const existing = threadDrafts(s.drafts, baseThreadGmailId)
        .filter((d) => (d.mode === "forward") === forward)
        .at(-1);
      if (existing) {
        get().openDraft(existing.client_id);
        return;
      }
    }
    const clientId = newClientId();
    // A reply or forward sends from the account its thread lives in; fresh
    // mail sends from the scoped account (the from-picker can change it).
    const baseAccountId = baseThreadGmailId
      ? (Object.values(s.threads) as Thread[]).find(
          (t) => t.gmail_id === baseThreadGmailId,
        )?.account_id
      : undefined;
    let draft: Draft = {
      client_id: clientId,
      account_id: baseAccountId ?? scopedAccount(s)?._id,
      mode,
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      body_text: "",
      updated_at: Date.now(),
    };
    if (mode !== "new" && baseThreadGmailId) {
      const meAcct = draft.account_id ? s.accounts[draft.account_id] : scopedAccount(s);
      const baseThread = (Object.values(s.threads) as Thread[]).find(
        (t) => t.gmail_id === baseThreadGmailId,
      );
      draft = {
        ...draft,
        ...seedCompose({
          mode,
          threadGmailId: baseThreadGmailId,
          baseSubject: baseThread?.subject ?? "",
          messages: s.threadMessages[baseThreadGmailId] ?? [],
          me: meAcct ?? undefined,
        }),
      };
    }
    // Nothing about the mail picked an address: the default, when it is this
    // mailbox's, else Gmail's.
    const preferred = defaultFrom(s);
    if (!draft.from && preferred && preferred.account._id === draft.account_id) {
      draft = { ...draft, from: preferred.email };
    }
    get().saveDraft(draft);
    set({ composeDraftId: clientId, composeMinimized: false });
  },

  updateComposeDraft: (fields: Partial<Draft>) => {
    const s = get();
    if (!s.composeDraftId) return;
    const current = s.drafts[s.composeDraftId];
    if (!current) return;
    get().saveDraft({ ...current, ...fields });
  },

  sendCompose: () => {
    const s = get();
    if (!s.composeDraftId) return;
    const d = s.drafts[s.composeDraftId];
    if (!d || d.to.length === 0) {
      get().pushToast("Add a recipient first", "error");
      return;
    }
    get().sendMessage({
      client_id: d.client_id,
      account_id: d.account_id,
      from: d.from,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      body_text: d.body_text,
      thread_gmail_id: d.thread_gmail_id,
      reply_to_gmail_id: d.reply_to_gmail_id,
      attachments: d.attachments,
    });
  },

  discardCompose: () => {
    const s = get();
    if (!s.composeDraftId) return;
    get().deleteDraft({ client_id: s.composeDraftId });
    get().pushToast("Draft discarded");
  },

  minimizeCompose: (min: boolean) => set({ composeMinimized: min, composeHeadOpen: false }),
  setComposeHeadOpen: (open: boolean) => set({ composeHeadOpen: open }),

  // ————— attachments —————

  openAttachment: (messageGmailId?: string, index = 0) => {
    const s = get();
    const t = s.openThreadId ? s.threads[s.openThreadId] : null;
    const msgs: Message[] = t ? (s.threadMessages[t.gmail_id] ?? []) : [];
    const target =
      (messageGmailId && msgs.find((m) => m.gmail_id === messageGmailId)) ||
      msgs.find((m) => m.gmail_id === s.msgFocusId && m.attachments.length > 0) ||
      msgs.find((m) => m.attachments.length > 0);
    if (!target || target.attachments.length === 0) return;
    const i = Math.min(Math.max(index, 0), target.attachments.length - 1);
    set({ attachmentViewer: { messageGmailId: target.gmail_id, index: i }, msgFocusId: target.gmail_id });
  },

  moveAttachment: (delta: number) => {
    const s = get();
    const v = s.attachmentViewer;
    const t = s.openThreadId ? s.threads[s.openThreadId] : null;
    const msgs: Message[] = t ? (s.threadMessages[t.gmail_id] ?? []) : [];
    if (!v) return;
    // Files across the whole conversation, in reading order, as one list.
    const all = msgs.flatMap((m) => m.attachments.map((_, index) => ({ messageGmailId: m.gmail_id, index })));
    const at = all.findIndex((f) => f.messageGmailId === v.messageGmailId && f.index === v.index);
    const next = all[at + delta];
    if (next) set({ attachmentViewer: next, msgFocusId: next.messageGmailId });
  },

  closeAttachment: () => set({ attachmentViewer: null }),
});

/**
 * Write one preference by its own key.
 *
 * Assigning the KEY matters: replacing the whole `clientState` object produces
 * a patch at `["clientState"]`, which names no field, and the dispatch
 * middleware skips it — which is how every preference written here used to
 * stay on the device that set it. Exported so a test can hold the patch shape
 * still (see mailStore.test.ts).
 */
/** Write a preference through the store's action, so it persists and syncs
 *  like any other. */
function applyClientPrefAndSave(get: () => MailState, key: string, value: unknown): void {
  get().setClientPref(key, value);
}

export function applyClientPref(
  state: { clientState: Record<string, any> },
  key: string,
  value: any,
): void {
  state.clientState[key] = value;
}

const engine = createSyncEngine(MAIL_PLATFORM_CONFIG);

const local = createLocalFirstStore<MailState>(MAIL_PLATFORM_CONFIG, creator as any);

/** The zustand hook — also carries getState/setState/subscribe. */
export const useMailStore = local.useStore;
/** Non-React access (event handlers, the key engine, sync wiring). */
export const mailStore = local.useStore;
export const useTracked = local.useTrackedStore;

// Dev console access, mirroring codecast's __inboxStore. Guarded without
// import.meta so the module parses under every bundler (Metro can't parse it).
declare const process: { env?: Record<string, string | undefined> } | undefined;
if (
  typeof window !== "undefined" &&
  typeof process !== "undefined" &&
  process?.env?.NODE_ENV !== "production"
) {
  (window as any).__mailStore = mailStore;
}
