import { randomUUID } from "crypto";
import type { Command } from "commander";
import type { Draft } from "@mail/shared/src/store/types";
import { fmt, icons } from "../colors";
import {
  dispatch,
  draftReply,
  findDraft,
  listDrafts,
  replySeed,
  rewrite,
  saveDraft,
  send,
  sendingAccount,
  session,
  summarize,
} from "../mail";
import { printDrafts } from "../output";
import { formatAddresses, parseAddresses, readBody } from "../text";
import { describeFiles, uploadFiles } from "../files";
import { formatSize } from "@mail/shared/src/lib/format";
import { fromAddress, isOwnAddress } from "@mail/shared/src/lib/sendAs";
import { emit, jsonOption, oneThread, settle, waitOption } from "./shared";

// Writing mail. Every path ends in the same two calls the app's compose
// makes: `send` for mail that leaves now, `saveDraft` for mail that waits.

type BodyOpts = { bodyFile?: string; draft?: boolean; wait?: boolean; attach?: string[] };

function bodyOptions(cmd: Command): Command {
  return waitOption(
    cmd
      .option("--body-file <path>", "read the body from a file")
      .option("--attach <path>", "attach a file (repeat for more)", (p: string, all: string[]) => [...all, p], [])
      .option("--draft", "save as a draft instead of sending"),
  );
}

function newDraft(fields: Omit<Draft, "client_id" | "updated_at">): Omit<Draft, "updated_at"> {
  return { client_id: randomUUID(), ...fields };
}

async function deliver(
  draft: Omit<Draft, "updated_at">,
  opts: { draft?: boolean; wait?: boolean },
  accountEmail: string,
): Promise<void> {
  const files = describeFiles(draft.attachments);
  if (opts.draft) {
    await saveDraft(draft);
    console.log(`${fmt.success(icons.check)} Draft ${fmt.id(draft.client_id.slice(0, 8))} saved (${formatAddresses(draft.to) || "no recipient yet"}${files}).`);
    return;
  }
  const { accounts } = await session();
  const account = accounts.find((a) => a._id === draft.account_id) ?? accounts.find((a) => a.email === accountEmail)!;
  const result = await send({ account, ...draft });
  // A brand new thread has only a local id until Gmail assigns one.
  const where = result.thread_gmail_id.startsWith("local-") ? "" : fmt.muted(" thread " + result.thread_gmail_id);
  console.log(`${fmt.success(icons.check)} Sent to ${formatAddresses(draft.to)} from ${fromAddress(account, draft.from).email}${files}${where}`);
  await settle(opts);
}

async function bodyOrFail(positional: string | undefined, opts: BodyOpts, what: string): Promise<string> {
  const body = await readBody(positional, opts);
  if (!body.trim() && !opts.draft) throw new Error(`${what} needs a body: as an argument, --body-file, or on stdin`);
  return body;
}

export function registerWrite(program: Command): void {
  const sendCmd = program
    .command("send [body]")
    .description("a new message; body from the argument, --body-file, or stdin")
    .requiredOption("--to <addresses>", "recipients (comma separated; \"Name <a@b>\" works)")
    .option("--cc <addresses>")
    .option("--bcc <addresses>")
    .option("--subject <text>", "subject line", "")
    .option("--from <address>", "the mailbox or send-as address it goes out from (needed with more than one mailbox)");
  bodyOptions(sendCmd).action(
    async (body: string | undefined, opts: BodyOpts & { to: string; cc?: string; bcc?: string; subject: string; from?: string }) => {
      const { accounts } = await session();
      const account = sendingAccount(accounts, opts.from);
      const text = await bodyOrFail(body, opts, "A message");
      await deliver(
        newDraft({
          account_id: account._id,
          // An address the mailbox sends as; a bare mailbox name sends as its default.
          from: opts.from && isOwnAddress(account, opts.from) ? opts.from : undefined,
          mode: "new",
          to: parseAddresses(opts.to),
          cc: parseAddresses(opts.cc),
          bcc: parseAddresses(opts.bcc),
          subject: opts.subject,
          body_text: text,
          attachments: await uploadFiles(opts.attach ?? []),
        }),
        opts,
        account.email,
      );
    },
  );

  const reply = program
    .command("reply <id> [body]")
    .description("answer the last message on a thread (--all for everyone on it)")
    .option("--all", "reply to everyone on the last message")
    .option("--cc <addresses>", "add people");
  bodyOptions(reply).action(async (id: string, body: string | undefined, opts: BodyOpts & { all?: boolean; cc?: string }) => {
    const { thread, account } = await oneThread(id);
    const text = await bodyOrFail(body, opts, "A reply");
    const seed = await replySeed(thread, opts.all ? "replyAll" : "reply", account);
    await deliver(
      newDraft({
        account_id: account._id,
        from: seed.from,
        mode: opts.all ? "replyAll" : "reply",
        to: seed.to,
        cc: parseAddresses(opts.cc),
        bcc: [],
        subject: seed.subject,
        body_text: text,
        thread_gmail_id: seed.thread_gmail_id,
        reply_to_gmail_id: seed.reply_to_gmail_id,
        attachments: await uploadFiles(opts.attach ?? []),
      }),
      opts,
      account.email,
    );
  });

  const forward = program
    .command("forward <id> [note]")
    .description("forward the last message on a thread, with an optional note above it; its files go along")
    .requiredOption("--to <addresses>", "recipients")
    .option("--cc <addresses>")
    .option("--no-files", "leave the original message's files behind");
  bodyOptions(forward).action(async (id: string, note: string | undefined, opts: BodyOpts & { to: string; cc?: string; files: boolean }) => {
    const { thread, account } = await oneThread(id);
    const seed = await replySeed(thread, "forward", account);
    const text = (await readBody(note, opts)) + seed.body_text;
    await deliver(
      newDraft({
        account_id: account._id,
        from: seed.from,
        mode: "forward",
        to: parseAddresses(opts.to),
        cc: parseAddresses(opts.cc),
        bcc: [],
        subject: seed.subject,
        body_text: text,
        thread_gmail_id: seed.thread_gmail_id,
        reply_to_gmail_id: seed.reply_to_gmail_id,
        attachments: [...(opts.files ? (seed.attachments ?? []) : []), ...(await uploadFiles(opts.attach ?? []))],
      }),
      opts,
      account.email,
    );
  });

  const suggest = program
    .command("suggest <id>")
    .description("a reply written in the human's voice; prints it, or --draft / --send to act on it")
    .option("-i, --instruction <text>", "what the reply should do (\"decline politely\", \"say yes for Thursday\")")
    .option("--draft", "save it as a draft")
    .option("--send", "send it as a reply");
  jsonOption(waitOption(suggest)).action(
    async (id: string, opts: { instruction?: string; draft?: boolean; send?: boolean; wait?: boolean; json?: boolean }) => {
      const { thread, account } = await oneThread(id);
      const text = await draftReply(thread, opts.instruction);
      if (!opts.draft && !opts.send) return emit(opts.json, { body_text: text }, () => console.log(text));
      const seed = await replySeed(thread, "reply", account);
      await deliver(
        newDraft({
          account_id: account._id,
          from: seed.from,
          mode: "reply",
          to: seed.to,
          cc: [],
          bcc: [],
          subject: seed.subject,
          body_text: text,
          thread_gmail_id: seed.thread_gmail_id,
          reply_to_gmail_id: seed.reply_to_gmail_id,
        }),
        { draft: opts.draft, wait: opts.wait },
        account.email,
      );
    },
  );

  jsonOption(program.command("summarize <id>").description("what happened on a thread and what needs the human")).action(
    async (id: string, opts: { json?: boolean }) => {
      const { thread } = await oneThread(id);
      const summary = await summarize(thread);
      emit(opts.json, { summary }, () => console.log(summary));
    },
  );

  program
    .command("rewrite [text]")
    .description("rewrite text in the human's voice; text from the argument, --body-file, or stdin")
    .requiredOption("-i, --instruction <text>", "how to change it (\"shorter\", \"warmer\", \"fix the tone\")")
    .option("--body-file <path>")
    .action(async (text: string | undefined, opts: { instruction: string; bodyFile?: string }) => {
      const body = await readBody(text, opts);
      if (!body.trim()) throw new Error("Nothing to rewrite");
      console.log(await rewrite(body, opts.instruction));
    });

  jsonOption(program.command("drafts").description("saved drafts, newest first")).action(async (opts: { json?: boolean }) => {
    const [{ accounts }, drafts] = await Promise.all([session(), listDrafts()]);
    emit(opts.json, drafts, () => printDrafts(drafts, accounts));
  });

  const draft = program.command("draft").description("one draft: show, send, rm");
  jsonOption(draft.command("show <id>").description("the draft's fields and body")).action(async (id: string, opts: { json?: boolean }) => {
    const d = await findDraft(id);
    emit(opts.json, d, () => {
      console.log(`${fmt.muted("To:      ")}${formatAddresses(d.to)}`);
      if (d.cc.length) console.log(`${fmt.muted("Cc:      ")}${formatAddresses(d.cc)}`);
      console.log(`${fmt.muted("Subject: ")}${d.subject}`);
      console.log(`${fmt.muted("Mode:    ")}${d.mode}${d.thread_gmail_id ? fmt.muted("  thread " + d.thread_gmail_id) : ""}`);
      if (d.attachments?.length) {
        console.log(`${fmt.muted("Files:   ")}${d.attachments.map((a) => `${a.filename} (${formatSize(a.size)})`).join(", ")}`);
      }
      console.log("");
      console.log(d.body_text);
    });
  });
  // The send carries the draft's own id, so the server retires the draft
  // with it and its files go out rather than being freed with the draft.
  waitOption(draft.command("send <id>").description("send a draft as it is")).action(async (id: string, opts: { wait?: boolean }) => {
    const d = await findDraft(id);
    const { accounts } = await session();
    const account = accounts.find((a) => a._id === d.account_id) ?? accounts[0];
    await deliver({ ...d, account_id: account._id }, { wait: opts.wait }, account.email);
  });
  draft
    .command("rm <id>")
    .alias("delete")
    .description("discard a draft")
    .action(async (id: string) => {
      const d = await findDraft(id);
      await dispatch("deleteDraft", { client_id: d.client_id, account_id: d.account_id });
      console.log(`Draft ${fmt.id(d.client_id.slice(0, 8))} discarded.`);
    });
}
