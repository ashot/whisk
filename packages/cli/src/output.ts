import type { Account, Draft, Message, Reminder, Thread } from "@mail/shared/src/store/types";
import { relativeDate, fullDate, participantsLine } from "@mail/shared/src/lib/format";
import { dueLabel } from "@mail/shared/src/lib/times";
import { categoryMeta } from "@mail/shared/src/lib/categories";
import { sendAddresses } from "@mail/shared/src/lib/sendAs";
import { clip, pad } from "@platform/cli-kit/text";
import { c, fmt, icons } from "./colors";
import { formatAddress, formatAddresses, messageText, stripQuotes } from "./text";

// Every read command prints one of these shapes. Plain text by default,
// `--json` for machines: the rows exactly as the backend returns them.

export { json } from "@platform/cli-kit/text";

/** Short tag for the account a row belongs to, when more than one is in
 *  scope: the local part, or the domain when local parts collide
 *  (ashot@a.com and ashot@b.com become @a and @b). */
export function accountTag(accounts: Account[], accountId: string): string {
  if (accounts.length <= 1) return "";
  const account = accounts.find((a) => a._id === accountId);
  if (!account) return "?";
  const [local, domain] = account.email.split("@");
  const sameLocal = accounts.filter((a) => a.email.split("@")[0] === local).length > 1;
  return sameLocal ? domain.replace(/\.[^.]+$/, "") : local;
}

/**
 * One thread per line: id, when, flags, people, subject, snippet, lane.
 *   18f3a2b4c5d6e7f8  2h   ● ★  Ada, Grace 3     Composer debate — I think we should…  [newsletters]
 */
export function threadLine(
  t: Thread,
  accounts: Account[],
  now = Date.now(),
  width = Math.max(80, process.stdout.columns ?? 120),
): string {
  const me = accounts.find((a) => a._id === t.account_id);
  const flags =
    (t.is_unread ? fmt.accent(icons.unread) : " ") +
    (t.is_starred ? fmt.warning(icons.star) : " ") +
    (t.has_attachments ? fmt.muted(icons.clip) : " ");
  const tag = accountTag(accounts, t.account_id);
  const lane = t.category ? fmt.muted(`[${categoryMeta(t.category)?.name.toLowerCase() ?? t.category}]`) : "";
  const head = `${fmt.id(t.gmail_id)}  ${pad(fmt.muted(relativeDate(t.last_at, now)), 6)} ${flags} ${pad(
    clip(participantsLine(t, me), 22),
    22,
  )}  `;
  const headWidth = head.replace(/\x1b\[[0-9;]*m/g, "").length;
  const room = Math.max(24, width - headWidth - (tag ? tag.length + 3 : 0) - (lane ? lane.length + 1 : 0));
  const subject = clip(t.subject || "(no subject)", Math.min(room, 70));
  const rest = room - subject.length - 3;
  const snippet = rest > 12 ? fmt.muted(clip(t.snippet, rest)) : "";
  const body = t.is_unread ? fmt.bold(subject) : subject;
  return `${head}${body}${snippet ? "  " + snippet : ""}${lane ? " " + lane : ""}${tag ? "  " + fmt.muted("@" + tag) : ""}`;
}

export function printThreads(rows: Thread[], accounts: Account[], opts: { empty?: string } = {}): void {
  if (rows.length === 0) {
    console.log(fmt.muted(opts.empty ?? "Nothing here."));
    return;
  }
  const now = Date.now();
  for (const t of rows) console.log(threadLine(t, accounts, now));
}

/** A whole thread, oldest message first. `full` keeps quoted trails. */
export function printThread(
  t: Thread,
  messages: Message[],
  accounts: Account[],
  opts: { full?: boolean; html?: boolean } = {},
): void {
  const tag = accountTag(accounts, t.account_id);
  console.log(`${fmt.bold(t.subject || "(no subject)")}`);
  console.log(
    fmt.muted(
      `thread ${t.gmail_id} ${icons.dot} ${messages.length} message${messages.length === 1 ? "" : "s"}` +
        (t.category ? ` ${icons.dot} ${categoryMeta(t.category)?.name ?? t.category}` : "") +
        (tag ? ` ${icons.dot} @${tag}` : "") +
        ` ${icons.dot} labels: ${t.label_ids.join(", ") || "none"}`,
    ),
  );
  for (const m of messages) {
    console.log("");
    console.log(`${c.dim}${"─".repeat(60)}${c.reset}`);
    console.log(`${fmt.muted("From:   ")}${formatAddress(m.from)}${m.is_unread ? "  " + fmt.accent("unread") : ""}`);
    console.log(`${fmt.muted("To:     ")}${formatAddresses(m.to)}`);
    if (m.cc?.length) console.log(`${fmt.muted("Cc:     ")}${formatAddresses(m.cc)}`);
    if (m.reply_to) console.log(`${fmt.muted("Reply-To: ")}${formatAddress(m.reply_to)}`);
    console.log(`${fmt.muted("Date:   ")}${fullDate(m.date)}`);
    console.log(`${fmt.muted("Message:")}${" "}${fmt.id(m.gmail_id)}`);
    if (m.attachments.length > 0) {
      console.log(
        `${fmt.muted("Files:  ")}${m.attachments
          .map((a, i) => `${i + 1}. ${a.filename} (${a.mime_type}, ${Math.round(a.size / 1024)} KB)`)
          .join("; ")}`,
      );
    }
    console.log("");
    const text = opts.html && m.body_html ? m.body_html : messageText(m);
    console.log(opts.full || opts.html ? text : stripQuotes(text) || text);
  }
}

export function printAccounts(accounts: Account[], pending: number, current?: string | null): void {
  if (accounts.length === 0) {
    console.log(fmt.muted("No mailboxes connected. Connect one at https://whisk.email."));
    return;
  }
  for (const a of accounts) {
    const status =
      a.sync_status === "error"
        ? fmt.error(`error: ${a.sync_error ?? "sync failed"}`)
        : a.sync_status === "idle"
          ? fmt.success("synced") + (a.last_synced_at ? fmt.muted(` ${relativeDate(a.last_synced_at)}`) : "")
          : fmt.warning(a.sync_status);
    // Topic grouping in flight rides the same line, so a regroup is visible
    // without opening the app.
    const p = a.cluster_progress;
    const grouping = a.clustering
      ? fmt.muted(`  grouping ${!p ? "starting" : p.tidy ? `tidying ${p.total} topics` : p.review ? `second look ${p.done}/${p.total}` : `${p.done}/${p.total}`}`)
      : a.cluster_error
        ? fmt.warning(`  topics: ${a.cluster_error}`)
        : "";
    console.log(
      `${pad(a.email, 34)} ${pad(a.provider, 6)} ${status}${a.email === current ? fmt.muted("  (default)") : ""}${grouping}`,
    );
    // The addresses it can send as, when there is more than the mailbox's own.
    const addresses = sendAddresses(a);
    if (addresses.length > 1) {
      const [first, ...rest] = addresses.map((x) => x.email);
      console.log(fmt.muted(`  sends from ${first} by default; also ${rest.join(", ")}`));
    }
  }
  if (pending > 0) console.log(fmt.muted(`${pending} write${pending === 1 ? "" : "s"} still on the way to Gmail`));
}

export function printDrafts(drafts: Draft[], accounts: Account[]): void {
  if (drafts.length === 0) {
    console.log(fmt.muted("No drafts."));
    return;
  }
  for (const d of [...drafts].sort((a, b) => b.updated_at - a.updated_at)) {
    const tag = d.account_id ? accountTag(accounts, d.account_id) : "";
    console.log(
      `${fmt.id(d.client_id.slice(0, 8))}  ${pad(fmt.muted(relativeDate(d.updated_at)), 6)} ${pad(d.mode, 8)} ${pad(
        clip(formatAddresses(d.to) || "(no recipient)", 28),
        28,
      )}  ${clip(d.subject || "(no subject)", 50)}${tag ? "  " + fmt.muted("@" + tag) : ""}`,
    );
  }
}

export function printReminders(reminders: Reminder[], threads: Map<string, Thread>, accounts: Account[]): void {
  if (reminders.length === 0) {
    console.log(fmt.muted("Nothing snoozed or watched."));
    return;
  }
  for (const r of [...reminders].sort((a, b) => a.remind_at - b.remind_at)) {
    const t = threads.get(`${r.account_id}:${r.thread_gmail_id}`);
    const kind = r.kind === "snooze" ? "snoozed" : r.status === "fired" ? "no reply" : "waiting";
    console.log(
      `${fmt.id(r.thread_gmail_id)}  ${pad(kind, 8)} ${pad(fmt.muted(dueLabel(r.remind_at)), 14)} ${clip(
        t?.subject ?? "(thread not synced)",
        60,
      )}${t ? fmt.muted("  " + (accountTag(accounts, t.account_id) ? "@" + accountTag(accounts, t.account_id) : "")) : ""}`,
    );
  }
}
