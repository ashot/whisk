import * as fs from "fs";
import * as path from "path";
import type { Command } from "commander";
import open from "open";
import { api } from "@mail/convex/convex/_generated/api";
import type { Label, Message, Thread } from "@mail/shared/src/store/types";
import { laneCounts } from "@mail/shared/src/store/selectors";
import { CATEGORIES } from "@mail/shared/src/lib/categories";
import { formatSize } from "@mail/shared/src/lib/format";
import { fmt } from "../colors";
import { query } from "../client";
import { settings, threadLink } from "../config";
import {
  listLabels,
  listThreads,
  matchAccount,
  resolveView,
  scopeAccounts,
  search,
  searchLocal,
  session,
  threadMessages,
} from "../mail";
import { printThread, printThreads, accountTag } from "../output";
import { accountOption, emit, jsonOption, oneThread } from "./shared";

// Reads. None of these change anything: listing and reading a thread leaves
// it unread, so an agent can look around without leaving footprints.

type ReadOpts = { account?: string; json?: boolean };

export function registerRead(program: Command): void {
  const ls = program
    .command("ls [view]")
    .alias("list")
    .description("threads in a view: inbox (default: the mail your importance policy calls important), other (the rest of the inbox), starred, sent, archive, trash, spam, later, waiting, a lane, or label:<name>; past the synced mail, Gmail supplies the rest")
    .option("-n, --limit <n>", "how many (no cap: older mail comes from Gmail)", "25")
    .option("--unread", "unread only")
    .option("--starred", "starred only")
    .option("--attachments", "with files only")
    .option("--from <who>", "a participant's name or address contains this")
    .option("--since <when>", "newer than: 3d, 12h, 2w, or a date");
  jsonOption(accountOption(ls)).action(
    async (
      view: string | undefined,
      opts: ReadOpts & { limit: string; unread?: boolean; starred?: boolean; attachments?: boolean; from?: string; since?: string },
    ) => {
      const [{ accounts }, labels] = await Promise.all([session(), listLabels()]);
      const resolved = resolveView(view, labels);
      const rows = await listThreads({
        view: resolved,
        labels,
        accounts: scopeAccounts(accounts, opts.account),
        limit: Math.max(1, Number(opts.limit) || 25),
        unread: opts.unread,
        starred: opts.starred,
        attachments: opts.attachments,
        from: opts.from,
        since: opts.since,
      });
      emit(opts.json, rows, () => printThreads(rows, accounts, { empty: `Nothing in ${view ?? "inbox"}.` }));
      // The inbox lists only important mail; say what sits beside it, so a
      // reader never takes the list for the whole inbox.
      if (!opts.json && resolved === "inbox") {
        const other = await listThreads({ view: "other", labels, accounts: scopeAccounts(accounts, opts.account), limit: 100_000, unread: opts.unread, starred: opts.starred, attachments: opts.attachments, from: opts.from, since: opts.since });
        if (other.length > 0) console.log(fmt.muted(`\n${other.length} more under Other: whisk ls other`));
      }
    },
  );

  jsonOption(accountOption(program.command("lanes").description("inbox counts per lane"))).action(async (opts: ReadOpts) => {
    const { accounts } = await session();
    const scope = opts.account ? matchAccount(accounts, opts.account)._id : "all";
    const page = await query(api.sync.listThreads, {});
    const all = Object.fromEntries((page.rows as Thread[]).filter((t) => !t.deleted).map((t) => [t._id, t]));
    const counts = laneCounts(all, scope);
    const rows = [{ id: "primary", name: "Primary" }, ...CATEGORIES].map((meta) => ({
      lane: meta.id,
      name: meta.name,
      total: counts.get(meta.id as any)?.total ?? 0,
      unread: counts.get(meta.id as any)?.unread ?? 0,
    }));
    emit(opts.json, rows, () => {
      for (const r of rows) {
        if (r.total === 0 && r.lane !== "primary") continue;
        console.log(`${r.lane.padEnd(14)} ${String(r.total).padStart(5)}${r.unread ? fmt.accent(`  ${r.unread} unread`) : ""}`);
      }
    });
  });

  jsonOption(accountOption(program.command("labels").description("Gmail labels, per mailbox"))).action(async (opts: ReadOpts) => {
    const [{ accounts }, labels] = await Promise.all([session(), listLabels()]);
    const scope = new Set(scopeAccounts(accounts, opts.account).map((a) => a._id));
    const rows = labels.filter((l) => scope.has(l.account_id)).sort(byKindThenName);
    emit(opts.json, rows, () => {
      // System labels exist in every mailbox under the same id: show once.
      const seen = new Set<string>();
      for (const l of rows) {
        if (l.kind === "system") {
          if (seen.has(l.gmail_id)) continue;
          seen.add(l.gmail_id);
        }
        const tag = l.kind === "system" ? "" : accountTag(accounts, l.account_id);
        console.log(`${l.name.padEnd(32)} ${fmt.muted(l.kind === "system" ? "system" : "user")}${tag ? fmt.muted("  @" + tag) : ""}`);
      }
    });
  });

  const searchCmd = program
    .command("search <query...>")
    .description("Gmail search over the whole mailbox (from:, to:, has:attachment, newer_than:7d, …)")
    .option("--local", "instant: only what is synced (subject, people, snippet)")
    .option("-n, --limit <n>", "how many (no cap: pages through Gmail until it has them)", "25");
  jsonOption(accountOption(searchCmd)).action(async (parts: string[], opts: ReadOpts & { local?: boolean; limit: string }) => {
    const q = parts.join(" ");
    const { accounts } = await session();
    const accountId = opts.account ? matchAccount(accounts, opts.account)._id : undefined;
    const limit = Math.max(1, Number(opts.limit) || 25);
    const rows = opts.local ? await searchLocal(q, accountId, limit) : await search(q, accountId, limit);
    emit(opts.json, rows, () => printThreads(rows, accounts, { empty: `No results for "${q}".` }));
  });

  const read = program
    .command("read <id>")
    .alias("show")
    .description("the whole thread, oldest first, quoted trails trimmed")
    .option("--full", "keep quoted trails and signatures")
    .option("--html", "print the HTML bodies as they are");
  jsonOption(read).action(async (id: string, opts: { full?: boolean; html?: boolean; json?: boolean }) => {
    const { thread, accounts } = await oneThread(id);
    const messages = await threadMessages(thread);
    emit(opts.json, { thread, messages, url: threadLink(thread.gmail_id) }, () =>
      printThread(thread, messages, accounts, opts),
    );
  });

  jsonOption(program.command("attachments <id>").description("files on a thread, with the message id to fetch each from")).action(
    async (id: string, opts: { json?: boolean }) => {
      const { thread } = await oneThread(id);
      const messages = await threadMessages(thread);
      const rows = messages.flatMap((m) =>
        m.attachments.map((a, i) => ({ message_gmail_id: m.gmail_id, index: i + 1, from: m.from.email, ...a })),
      );
      emit(opts.json, rows, () => {
        if (rows.length === 0) return console.log(fmt.muted("No files on this thread."));
        for (const r of rows) {
          console.log(`${fmt.id(r.message_gmail_id)} ${r.index}  ${r.filename.padEnd(40)} ${fmt.muted(`${r.mime_type} ${formatSize(r.size)}`)}`);
        }
        console.log(fmt.muted(`\nFetch one: whisk attachment <message-id> <n|name> -o ./dir`));
      });
    },
  );

  program
    .command("attachment <message-id> [which]")
    .description("download a file: by number or name (default: the first); prints the path")
    .option("-o, --out <dir>", "directory to save into", ".")
    .action(async (messageId: string, which: string | undefined, opts: { out: string }) => {
      const { thread } = await oneThread(messageId);
      const messages = await threadMessages(thread);
      const message = pickMessage(messages, messageId);
      const file = pickAttachment(message, which);
      const { siteUrl, token } = settings();
      const url = new URL(`${siteUrl}/gmail/attachment`);
      url.searchParams.set("token", token ?? "");
      url.searchParams.set("message", message.gmail_id);
      url.searchParams.set("id", file.gmail_attachment_id);
      url.searchParams.set("name", file.filename);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Download failed: ${response.status} ${await response.text()}`);
      fs.mkdirSync(opts.out, { recursive: true });
      const target = path.join(opts.out, file.filename.replace(/[/\\]/g, "_"));
      fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
      console.log(target);
    });

  // Links are built, not looked up: no round trip, and the app resolves a
  // message id to its thread on open.
  program
    .command("link <id...>")
    .description("the URL that opens a thread in the app, one per id; paste it anywhere")
    .action((ids: string[]) => {
      for (const id of ids) console.log(threadLink(id));
    });

  program
    .command("open <id>")
    .description("open the thread in the browser (--print for the URL only)")
    .option("--print", "print the URL only")
    .action(async (id: string, opts: { print?: boolean }) => {
      const url = threadLink(id);
      console.log(url);
      if (!opts.print) await open(url).catch(() => {});
    });
}

function byKindThenName(a: Label, b: Label): number {
  if (a.kind !== b.kind) return a.kind === "system" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** The message an id names; a thread id means its one message with files. */
function pickMessage(messages: Message[], id: string): Message {
  const exact = messages.find((m) => m.gmail_id === id);
  if (exact) return exact;
  const withFiles = messages.filter((m) => m.attachments.length > 0);
  if (withFiles.length === 1) return withFiles[0];
  throw new Error(`Several messages have files; name one: whisk attachments ${id}`);
}

function pickAttachment(message: Message, which: string | undefined) {
  const files = message.attachments;
  if (files.length === 0) throw new Error("That message has no files");
  if (!which) return files[0];
  const n = Number(which);
  if (Number.isInteger(n) && n >= 1 && n <= files.length) return files[n - 1];
  const named = files.find((f) => f.filename.toLowerCase() === which.toLowerCase()) ?? files.find((f) => f.filename.toLowerCase().includes(which.toLowerCase()));
  if (!named) throw new Error(`No file "${which}" (have: ${files.map((f) => f.filename).join(", ")})`);
  return named;
}
