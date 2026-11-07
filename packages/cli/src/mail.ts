import { randomUUID } from "crypto";
import { api } from "@mail/convex/convex/_generated/api";
import type {
  Account,
  Draft,
  Label,
  Message,
  OutgoingAttachment,
  Reminder,
  Thread,
  ThreadOp,
  ViewId,
} from "@mail/shared/src/store/types";
import { L } from "@mail/shared/src/store/types";
import { threadInView, liveReminders, reminderFor } from "@mail/shared/src/store/selectors";
import { seedCompose } from "@mail/shared/src/lib/compose";
import { isOwnAddress } from "@mail/shared/src/lib/sendAs";
import { isCategoryId } from "@mail/shared/src/lib/categories";
import { action, errorMessage, mutation, query } from "./client";
import { parseSince } from "./when";

// The mail domain as the CLI sees it: a thin layer over the same Convex
// functions the web app calls. No local projection — every command reads
// what it needs and writes through `dispatch`, exactly like a web gesture.

export type Session = {
  accounts: Account[];
  outbound_pending: number;
};

export async function session(): Promise<Session> {
  const envelope = await query(api.sync.getAccount, {});
  return {
    accounts: (envelope.accounts ?? []) as Account[],
    outbound_pending: envelope.outbound_pending,
  };
}

/**
 * Pick one account by email (any address it sends as), email prefix, name,
 * or Convex id. Case does not matter. Throws when nothing or more than one
 * thing matches.
 */
export function matchAccount(accounts: Account[], wanted: string): Account {
  const needle = wanted.trim().toLowerCase();
  const exact = accounts.find(
    (a) => a._id === wanted || isOwnAddress(a, needle),
  );
  if (exact) return exact;
  const loose = accounts.filter(
    (a) =>
      a.email.toLowerCase().startsWith(needle) ||
      a.email.toLowerCase().includes(needle) ||
      (a.name ?? "").toLowerCase().includes(needle),
  );
  if (loose.length === 1) return loose[0];
  if (loose.length === 0) {
    throw new Error(
      `No account matches "${wanted}". Connected: ${accounts.map((a) => a.email).join(", ")}`,
    );
  }
  throw new Error(
    `"${wanted}" matches several accounts: ${loose.map((a) => a.email).join(", ")}`,
  );
}

/** Accounts in scope for a read: all of them, or the one `--account` names. */
export function scopeAccounts(accounts: Account[], wanted?: string): Account[] {
  return wanted ? [matchAccount(accounts, wanted)] : accounts;
}

/** The account a new message sends from. One connected account needs no
 *  flag; more than one must be named, so an agent never guesses. */
export function sendingAccount(accounts: Account[], from?: string): Account {
  if (from) return matchAccount(accounts, from);
  if (accounts.length === 1) return accounts[0];
  throw new Error(
    `Several accounts are connected — say which one sends with --from <email>: ${accounts
      .map((a) => a.email)
      .join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export type ListOptions = {
  view: ViewId;
  accounts: Account[];
  /** Needed for label views: the same label has a different Gmail id per mailbox. */
  labels?: Label[];
  limit: number;
  unread?: boolean;
  starred?: boolean;
  from?: string;
  since?: string;
  attachments?: boolean;
};

/** Threads of a view, newest first, across the accounts in scope. Later and
 *  Waiting join the reminders table, like the app's rail does. The synced
 *  projection answers first; when it holds fewer than asked, Gmail answers the
 *  same view as a query, so older mail is reachable just by raising the limit. */
export async function listThreads(opts: ListOptions): Promise<Thread[]> {
  const scope = new Set(opts.accounts.map((a) => a._id));
  const page = await query(api.sync.listThreads, {});
  let rows = (page.rows as Thread[]).filter((t) => scope.has(t.account_id) && !t.deleted);

  if (opts.view === "later" || opts.view === "waiting") {
    const reminders = await query(api.reminders.listReminders, {});
    const live = liveReminders(Object.fromEntries(reminders.map((r) => [r._id, r as Reminder])));
    const kind = opts.view === "later" ? "snooze" : "followup";
    const due = new Map<string, number>();
    rows = rows.filter((t) => {
      const r = reminderFor(live, t);
      if (!r || r.kind !== kind) return false;
      due.set(t._id, r.remind_at);
      return true;
    });
    rows.sort((a, b) => due.get(a._id)! - due.get(b._id)!);
    return rows.filter(threadFilter(opts)).slice(0, opts.limit);
  }

  const keep = threadFilter(opts);
  let inView: (t: Thread) => boolean = (t) => threadInView(t, opts.view);
  if (opts.view.startsWith("label:") && opts.labels) {
    const sample = opts.labels.find((l) => l.gmail_id === opts.view.slice("label:".length));
    const perAccount = new Map(
      opts.accounts.map((a) => [a._id, sample && labelInAccount(opts.labels!, sample, a._id)?.gmail_id]),
    );
    inView = (t) => {
      const id = perAccount.get(t.account_id);
      return !!id && t.label_ids.includes(id);
    };
  }
  const matches = (t: Thread) => scope.has(t.account_id) && !t.deleted && inView(t) && keep(t);
  rows = rows.filter(matches);

  const q = rows.length < opts.limit ? gmailQueryForList(opts) : null;
  if (q) {
    const accountId = opts.accounts.length === 1 ? opts.accounts[0]._id : undefined;
    const seen = new Set(rows.map((t) => t._id));
    for (const t of await search(q, accountId, opts.limit)) {
      if (!seen.has(t._id) && matches(t)) rows.push(t);
    }
  }
  rows.sort((a, b) => b.last_at - a.last_at);
  return rows.slice(0, opts.limit);
}

/** The --unread/--starred/--attachments/--from/--since flags as one predicate. */
function threadFilter(opts: ListOptions): (t: Thread) => boolean {
  const needle = opts.from?.toLowerCase();
  const cutoff = opts.since ? sinceCutoff(opts.since) : null;
  return (t) =>
    (!opts.unread || t.is_unread) &&
    (!opts.starred || t.is_starred) &&
    (!opts.attachments || t.has_attachments) &&
    (!needle ||
      t.participants.some(
        (p) => p.email.toLowerCase().includes(needle) || (p.name ?? "").toLowerCase().includes(needle),
      )) &&
    (cutoff === null || t.last_at >= cutoff);
}

function sinceCutoff(since: string): number {
  const cutoff = parseSince(since);
  if (cutoff === null) throw new Error(`Cannot read --since "${since}" (try 3d, 12h, 2w, or a date)`);
  return cutoff;
}

/** The same view and flags in Gmail's query grammar, or null for views only
 *  Whisk knows (lanes, topics, reminders). */
export function gmailQueryForList(opts: ListOptions): string | null {
  const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, "")}"` : s);
  const views: Record<string, string> = {
    inbox: "in:inbox",
    starred: "is:starred",
    sent: "in:sent",
    archive: "-in:inbox -in:drafts",
    trash: "in:trash",
    spam: "in:spam",
  };
  let base = views[opts.view];
  if (!base && opts.view.startsWith("label:")) {
    const label = opts.labels?.find((l) => l.gmail_id === opts.view.slice("label:".length));
    // Gmail's own spelling of a label in a query: lowercase, spaces as dashes, never quoted.
    if (label) base = `label:${label.name.toLowerCase().replace(/\s+/g, "-")}`;
  }
  if (!base) return null;
  const parts = [base];
  if (opts.unread) parts.push("is:unread");
  if (opts.starred) parts.push("is:starred");
  if (opts.attachments) parts.push("has:attachment");
  if (opts.from) {
    const who = quote(opts.from);
    parts.push(`{from:${who} to:${who} cc:${who}}`);
  }
  if (opts.since) parts.push(`after:${Math.floor(sinceCutoff(opts.since) / 1000)}`);
  return parts.join(" ");
}

/** Named views an agent can ask for on the command line. */
export function resolveView(name: string | undefined, labels: Label[]): ViewId {
  const raw = (name ?? "inbox").trim();
  const lower = raw.toLowerCase();
  const plain: ViewId[] = ["inbox", "other", "starred", "sent", "archive", "trash", "spam", "later", "waiting"];
  if ((plain as string[]).includes(lower)) return lower as ViewId;
  if (lower === "all" || lower === "everything") return "archive"; // closest: not inbox, not trash
  if (lower === "snoozed") return "later";
  if (lower === "important") return "inbox";
  if (lower === "primary" || isCategoryId(lower)) return `cat:${lower}`;
  if (lower.startsWith("cat:") || lower.startsWith("lane:")) {
    const lane = lower.slice(lower.indexOf(":") + 1);
    if (lane === "primary" || isCategoryId(lane)) return `cat:${lane}`;
    throw new Error(`Unknown lane "${lane}"`);
  }
  const labelName = lower.startsWith("label:") ? raw.slice("label:".length) : raw;
  const label = findLabel(labels, labelName);
  if (label) return `label:${label.gmail_id}`;
  if (lower.startsWith("label:")) throw new Error(`No label "${labelName}". See: whisk labels`);
  throw new Error(
    `Unknown view "${raw}". Views: inbox (the important mail), other (the rest of the inbox), starred, sent, archive, trash, spam, later, waiting, a lane (newsletters, receipts, …) or a label name.`,
  );
}

/** Thread rows for the ids given (thread or message ids). Throws on any id
 *  the caller cannot see, so a typo never silently does nothing. */
export async function resolveThreads(ids: string[]): Promise<Thread[]> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) throw new Error("No thread ids given");
  const rows = (await query(api.sync.threadsByIds, { gmailIds: unique })) as Thread[];
  const found = new Set(rows.map((r) => r.gmail_id));
  // A message id resolves to its thread, whose gmail_id differs from the input.
  const missing = unique.length > rows.length ? unique.filter((id) => !found.has(id)) : [];
  if (rows.length < unique.length) {
    throw new Error(`Unknown thread${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  }
  return rows;
}

export async function threadMessages(thread: Thread): Promise<Message[]> {
  return (await query(api.sync.threadMessages, {
    threadGmailId: thread.gmail_id,
    accountId: thread.account_id as any,
  })) as Message[];
}

// ---------------------------------------------------------------------------
// Labels and lanes
// ---------------------------------------------------------------------------

export async function listLabels(): Promise<Label[]> {
  return ((await query(api.sync.listLabels, {})) as Label[]).filter((l) => !l.deleted);
}

/** A label by name (case-insensitive) or Gmail id, any account. */
export function findLabel(labels: Label[], wanted: string): Label | undefined {
  const needle = wanted.trim().toLowerCase();
  return (
    labels.find((l) => l.gmail_id === wanted) ??
    labels.find((l) => l.name.toLowerCase() === needle) ??
    labels.find((l) => l.gmail_id.toLowerCase() === needle)
  );
}

/** The same label in the account a thread lives in; user labels have a
 *  different Gmail id per mailbox even when their names match. */
export function labelInAccount(labels: Label[], sample: Label, accountId: string): Label | undefined {
  if (sample.kind === "system") return labels.find((l) => l.account_id === accountId && l.gmail_id === sample.gmail_id) ?? sample;
  return labels.find(
    (l) => l.account_id === accountId && l.name.toLowerCase() === sample.name.toLowerCase(),
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function dispatch(actionName: string, args: unknown): Promise<any> {
  return mutation(api.dispatch.dispatch, { action: actionName, args: [args] });
}

/** Group threads by account into one op each, the way every unified-view
 *  gesture in the app does, then dispatch them together. */
export async function applyToThreads(
  threads: Thread[],
  add: string[],
  remove: string[],
  perAccount?: (accountId: string) => { add: string[]; remove: string[] } | null,
): Promise<{ applied: number }> {
  const byAccount = new Map<string, string[]>();
  for (const t of threads) {
    byAccount.set(t.account_id, [...(byAccount.get(t.account_id) ?? []), t.gmail_id]);
  }
  const ops: ThreadOp[] = [];
  for (const [account_id, thread_gmail_ids] of byAccount) {
    const delta = perAccount ? perAccount(account_id) : { add, remove };
    if (!delta) continue;
    ops.push({ thread_gmail_ids, add_label_ids: delta.add, remove_label_ids: delta.remove, account_id });
  }
  const result = await dispatch("applyThreadOps", { ops });
  return { applied: result?.applied?.length ?? 0 };
}

export const OPS = {
  archive: { add: [], remove: [L.INBOX] },
  inbox: { add: [L.INBOX], remove: [L.TRASH, L.SPAM] },
  trash: { add: [L.TRASH], remove: [L.INBOX] },
  untrash: { add: [L.INBOX], remove: [L.TRASH] },
  read: { add: [], remove: [L.UNREAD] },
  unread: { add: [L.UNREAD], remove: [] },
  star: { add: [L.STARRED], remove: [] },
  unstar: { add: [], remove: [L.STARRED] },
} as const;

export type SendInput = {
  account: Account;
  /** The address it sends as; absent = the account's default. */
  from?: string;
  /** A draft's id, when sending one: the server retires the draft with the send. */
  client_id?: string;
  to: Message["to"];
  cc?: Message["to"];
  bcc?: Message["to"];
  subject: string;
  body_text: string;
  thread_gmail_id?: string;
  reply_to_gmail_id?: string;
  attachments?: OutgoingAttachment[];
};

export async function send(input: SendInput): Promise<{ thread_gmail_id: string; message_gmail_id: string }> {
  if (input.to.length === 0) throw new Error("A message needs at least one recipient (--to)");
  const client_id = input.client_id ?? randomUUID();
  const result = await dispatch("sendMessage", {
    client_id,
    account_id: input.account._id,
    from: input.from,
    to: input.to,
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    subject: input.subject,
    body_text: input.body_text,
    thread_gmail_id: input.thread_gmail_id,
    reply_to_gmail_id: input.reply_to_gmail_id,
    attachments: input.attachments ?? [],
  });
  return { thread_gmail_id: result.thread_gmail_id, message_gmail_id: result.message_gmail_id };
}

/** Seed a reply or forward from a thread, the way the app's compose does. */
export async function replySeed(
  thread: Thread,
  mode: "reply" | "replyAll" | "forward",
  account: Account,
) {
  const messages = await threadMessages(thread);
  return seedCompose({
    mode,
    threadGmailId: thread.gmail_id,
    baseSubject: thread.subject,
    messages,
    me: account,
  });
}

export async function listDrafts(): Promise<Draft[]> {
  return ((await query(api.sync.listDrafts, {})) as Array<Draft & { deleted?: boolean }>).filter(
    (d) => !d.deleted,
  );
}

export async function saveDraft(draft: Omit<Draft, "updated_at">): Promise<void> {
  await dispatch("saveDraft", draft);
}

export async function findDraft(id: string): Promise<Draft> {
  const drafts = await listDrafts();
  const hit = drafts.find((d) => d.client_id === id || d.client_id.startsWith(id));
  if (!hit) throw new Error(`No draft ${id}`);
  return hit;
}

// ---------------------------------------------------------------------------
// Reminders, filing, memories, AI
// ---------------------------------------------------------------------------

export async function setReminder(thread: Thread, kind: "snooze" | "followup", remindAt: number) {
  await dispatch("setReminder", {
    thread_gmail_id: thread.gmail_id,
    account_id: thread.account_id,
    kind,
    remind_at: remindAt,
  });
}

export async function cancelReminder(thread: Thread) {
  await dispatch("cancelReminder", { thread_gmail_id: thread.gmail_id, account_id: thread.account_id });
}

export async function listReminders(): Promise<Reminder[]> {
  return ((await query(api.reminders.listReminders, {})) as Reminder[]).filter(
    (r) => !r.deleted && (r.status === "armed" || r.status === "fired"),
  );
}

export async function fileThreads(threads: Thread[], category: string | null, remember: boolean) {
  const byAccount = new Map<string, string[]>();
  for (const t of threads) {
    byAccount.set(t.account_id, [...(byAccount.get(t.account_id) ?? []), t.gmail_id]);
  }
  let refiled = 0;
  for (const [account_id, thread_gmail_ids] of byAccount) {
    const result = await dispatch("setCategory", { thread_gmail_ids, category, account_id, remember });
    refiled += result?.refiled ?? 0;
  }
  return { refiled };
}

export async function summarize(thread: Thread): Promise<string> {
  const result = await action(api.ai.actions.summarizeThread, {
    threadGmailId: thread.gmail_id,
    accountId: thread.account_id as any,
  });
  return result.summary;
}

export async function draftReply(thread: Thread, instruction?: string): Promise<string> {
  const result = await action(api.ai.actions.draftReply, {
    threadGmailId: thread.gmail_id,
    accountId: thread.account_id as any,
    instruction,
  });
  return result.body_text;
}

export async function rewrite(text: string, instruction: string): Promise<string> {
  const result = await action(api.ai.actions.rewrite, { text, instruction });
  return result.text;
}

/** Ask Gmail itself (bodies, older mail) and return up to `limit` hits as
 *  thread rows in Gmail's rank order, paging until it has them or the mailbox
 *  is drained; the projection imports what it lacked. There is no cap: a
 *  large limit walks the whole mailbox, at Gmail's per-user quota pace.
 *  A long walk reports its progress on stderr, and Ctrl-C or `timeout` ends
 *  it with the results it has, so neither reads as a hang or loses work. */
export async function search(q: string, accountId?: string, limit = 25): Promise<Thread[]> {
  const rows: Thread[] = [];
  const seen = new Set<string>();
  const started = Date.now();
  const progress = progressLine();
  const stop = interruption();
  let cursor: string | null = null;
  try {
    do {
      const next = action(api.search.runFullSearch, {
        q,
        accountId: accountId as any,
        cursor: cursor ?? undefined,
      }) as Promise<{ rows: Thread[]; cursor: string | null }>;
      let page: Awaited<typeof next> | number;
      try {
        page = await Promise.race([next, stop.signal]);
      } catch (error) {
        // Pages already fetched are real results; say where it stopped instead
        // of discarding them. stdout stays clean for --json.
        if (rows.length === 0) throw error;
        progress.done();
        console.error(`whisk: stopped after ${rows.length} results, Gmail failed on the next page: ${errorMessage(error)}`);
        break;
      }
      if (typeof page === "number") {
        progress.done();
        console.error(`whisk: stopped after ${rows.length} results, interrupted`);
        exitAfterOutput(page);
        break;
      }
      for (const row of page.rows) {
        if (!seen.has(row._id)) {
          seen.add(row._id);
          rows.push(row);
        }
      }
      cursor = page.cursor;
      if (cursor && Date.now() - started > PROGRESS_AFTER_MS && rows.length > 0) {
        const oldest = Math.min(...rows.map((t) => t.last_at));
        progress.show(`whisk: ${rows.length} results so far, back to ${new Date(oldest).toISOString().slice(0, 10)}…`);
      }
    } while (cursor && rows.length < limit);
  } finally {
    stop.release();
  }
  progress.done();
  return rows.slice(0, limit);
}

/** A search quicker than this finishes silently. */
const PROGRESS_AFTER_MS = 3_000;

/** One status line on stderr: rewritten in place on a terminal, a line per
 *  update into a log. */
function progressLine() {
  const tty = process.stderr.isTTY;
  let shown = false;
  return {
    show(text: string) {
      shown = true;
      process.stderr.write(tty ? `\r\x1b[K${text}` : `${text}\n`);
    },
    done() {
      if (shown && tty) process.stderr.write("\r\x1b[K");
      shown = false;
    },
  };
}

/** Settles with the shell's exit code (130, 143) on Ctrl-C or SIGTERM, so a
 *  loop can stop between steps; `release` restores the default handling. */
function interruption() {
  let release = () => {};
  const signal = new Promise<number>((resolve) => {
    const onInt = () => resolve(130);
    const onTerm = () => resolve(143);
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
    release = () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    };
  });
  return { signal, release: () => release() };
}

/** Exit once the command has written its output. The request in flight when
 *  the signal came would otherwise hold the process open until it returns. */
function exitAfterOutput(code: number) {
  setTimeout(() => process.stdout.write("", () => process.exit(code)), 0);
}

/** The local projection only: subject, people and snippet. Instant, no Gmail. */
export async function searchLocal(q: string, accountId?: string, limit = 50): Promise<Thread[]> {
  return (await query(api.search.searchThreads, { q, accountId: accountId as any, limit })) as Thread[];
}

/** Poll until every queued write has reached Gmail, or `timeoutMs` passes.
 *  Returns how many are still pending. */
export async function waitForOutbound(timeoutMs = 30_000): Promise<number> {
  const started = Date.now();
  let pending = (await session()).outbound_pending;
  while (pending > 0 && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1000));
    pending = (await session()).outbound_pending;
  }
  return pending;
}

export async function refresh(): Promise<boolean> {
  const result = await mutation(api.sync.refresh, {});
  return result.scheduled;
}
