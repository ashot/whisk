import type { Command } from "commander";
import { api } from "@mail/convex/convex/_generated/api";
import type { Memory, Thread } from "@mail/shared/src/store/types";
import { isCategoryId, CATEGORY_IDS } from "@mail/shared/src/lib/categories";
import { fmt } from "../colors";
import { query } from "../client";
import {
  OPS,
  applyToThreads,
  cancelReminder,
  dispatch,
  fileThreads,
  findLabel,
  labelInAccount,
  listLabels,
  listReminders,
  matchAccount,
  resolveThreads,
  session,
  setReminder,
} from "../mail";
import { accountTag, printReminders } from "../output";
import { whenOrThrow } from "../when";
import { accountOption, emit, ids, jsonOption, plural, settle, waitOption } from "./shared";

// Triage: every verb takes any number of ids, groups them by mailbox, and
// dispatches one op per mailbox, the way a multi-select gesture in the app
// does. Nothing here is irreversible except `delete`, which insists on --yes.

type WaitOpts = { wait?: boolean };

export function registerTriage(program: Command): void {
  const verbs: Array<[keyof typeof OPS, string, string]> = [
    ["archive", "archive threads (out of the inbox, kept in All Mail)", "Archived"],
    ["inbox", "move threads back to the inbox", "Moved to inbox"],
    ["trash", "move threads to the trash", "Trashed"],
    ["untrash", "take threads out of the trash", "Restored"],
    ["star", "star threads", "Starred"],
    ["unstar", "unstar threads", "Unstarred"],
  ];
  for (const [verb, description, past] of verbs) {
    waitOption(program.command(`${verb} <ids...>`).description(description)).action(async (list: string[], opts: WaitOpts) => {
      const threads = await resolveThreads(ids(list));
      await applyToThreads(threads, [...OPS[verb].add], [...OPS[verb].remove]);
      console.log(`${past} ${plural(threads.length, "thread")}.`);
      await settle(opts);
    });
  }

  waitOption(program.command("spam <ids...>").description("report threads as spam")).action(async (list: string[], opts: WaitOpts) => {
    const threads = await resolveThreads(ids(list));
    for (const [account_id, thread_gmail_ids] of byAccount(threads)) {
      await dispatch("markSpam", { thread_gmail_ids, account_id });
    }
    console.log(`Marked ${plural(threads.length, "thread")} as spam.`);
    await settle(opts);
  });

  for (const [verb, important, description] of [
    ["important", true, "mark threads important: they show in the inbox, and Whisk learns from it"],
    ["other", false, "mark threads not important: they move to Other, and Whisk learns from it"],
  ] as const) {
    waitOption(program.command(`${verb} <ids...>`).description(description)).action(async (list: string[], opts: WaitOpts) => {
      const threads = await resolveThreads(ids(list));
      for (const [account_id, thread_gmail_ids] of byAccount(threads)) {
        await dispatch("setImportance", { thread_gmail_ids, important, account_id });
      }
      console.log(`Moved ${plural(threads.length, "thread")} to ${important ? "Important" : "Other"}.`);
      await settle(opts);
    });
  }

  waitOption(program.command("mark <read|unread> <ids...>").description("mark threads read or unread")).action(
    async (state: string, list: string[], opts: WaitOpts) => {
      if (state !== "read" && state !== "unread") throw new Error(`mark takes "read" or "unread", not "${state}"`);
      const threads = await resolveThreads(ids(list));
      await applyToThreads(threads, [...OPS[state].add], [...OPS[state].remove]);
      console.log(`Marked ${plural(threads.length, "thread")} ${state}.`);
      await settle(opts);
    },
  );

  const label = program.command("label").description("add or remove a Gmail label (whisk labels lists them)");
  for (const [verb, add] of [
    ["add", true],
    ["rm", false],
  ] as const) {
    waitOption(label.command(`${verb} <label> <ids...>`).description(add ? "put a label on threads" : "take a label off threads")).action(
      async (name: string, list: string[], opts: WaitOpts) => {
        const [labels, threads] = await Promise.all([listLabels(), resolveThreads(ids(list))]);
        const sample = findLabel(labels, name);
        if (!sample) throw new Error(`No label "${name}". See: whisk labels`);
        await applyToThreads(threads, [], [], (accountId) => {
          const mine = labelInAccount(labels, sample, accountId);
          if (!mine) throw new Error(`Label "${sample.name}" does not exist in every mailbox these threads live in`);
          return add ? { add: [mine.gmail_id], remove: [] } : { add: [], remove: [mine.gmail_id] };
        });
        console.log(`${add ? "Labeled" : "Unlabeled"} ${plural(threads.length, "thread")} (${sample.name}).`);
        await settle(opts);
      },
    );
  }

  program
    .command("file <lane> <ids...>")
    .description(`move threads to a lane (${["primary", ...CATEGORY_IDS].join(", ")}); teaches a sender rule unless --no-remember`)
    .option("--no-remember", "one-off: do not learn a rule from this")
    .action(async (lane: string, list: string[], opts: { remember: boolean }) => {
      const wanted = lane.toLowerCase();
      if (wanted !== "primary" && !isCategoryId(wanted)) throw new Error(`Unknown lane "${lane}". Lanes: primary, ${CATEGORY_IDS.join(", ")}`);
      const threads = await resolveThreads(ids(list));
      const { refiled } = await fileThreads(threads, wanted === "primary" ? null : wanted, opts.remember);
      console.log(`Filed ${plural(threads.length, "thread")} under ${wanted}${opts.remember && refiled > 0 ? fmt.muted(`; ${refiled} more from the same senders followed`) : ""}.`);
    });

  for (const [verb, kind, past] of [
    ["snooze", "snooze", "Snoozed"],
    ["followup", "followup", "Watching"],
  ] as const) {
    program
      .command(`${verb} <when> <ids...>`)
      .description(
        kind === "snooze"
          ? "hide threads until a time: 3h, tomorrow, tonight, weekend, \"mon 9am\", 2026-09-10"
          : "bring threads back if nobody replies by a time",
      )
      .action(async (when: string, list: string[]) => {
        const at = whenOrThrow(when);
        const threads = await resolveThreads(ids(list));
        for (const t of threads) await setReminder(t, kind, at);
        console.log(`${past} ${plural(threads.length, "thread")} until ${new Date(at).toLocaleString()}.`);
      });
  }

  program
    .command("unsnooze <ids...>")
    .alias("unwatch")
    .description("cancel a snooze or a follow-up")
    .action(async (list: string[]) => {
      const threads = await resolveThreads(ids(list));
      for (const t of threads) await cancelReminder(t);
      console.log(`Cleared ${plural(threads.length, "reminder")}.`);
    });

  jsonOption(program.command("reminders").description("everything snoozed or watched, soonest first")).action(async (opts: { json?: boolean }) => {
    const [{ accounts }, reminders] = await Promise.all([session(), listReminders()]);
    const threads = reminders.length ? await resolveThreadsLoose(reminders.map((r) => r.thread_gmail_id)) : [];
    const byKey = new Map(threads.map((t) => [`${t.account_id}:${t.gmail_id}`, t]));
    emit(opts.json, reminders, () => printReminders(reminders, byKey, accounts));
  });

  waitOption(program.command("delete <ids...>").description("delete threads permanently, skipping the trash").option("--yes", "confirm: this cannot be undone")).action(
    async (list: string[], opts: WaitOpts & { yes?: boolean }) => {
      if (!opts.yes) throw new Error("Permanent delete needs --yes (or use whisk trash)");
      const threads = await resolveThreads(ids(list));
      let deleted = 0;
      for (const [account_id, thread_gmail_ids] of byAccount(threads)) {
        const result = await dispatch("deleteForever", { thread_gmail_ids, account_id });
        deleted += result?.deleted?.length ?? 0;
      }
      console.log(`Deleted ${plural(deleted, "thread")} permanently.`);
      await settle(opts);
    },
  );

  jsonOption(accountOption(program.command("memories").description("what Whisk remembers about the human: voice, contacts, filing rules, preferences"))).action(
    async (opts: { account?: string; json?: boolean }) => {
      const { accounts } = await session();
      const scope = opts.account ? new Set([matchAccount(accounts, opts.account)._id]) : null;
      const rows = ((await query(api.memories.listMemories, {})) as Memory[])
        .filter((m) => !m.deleted && (!scope || scope.has(m.account_id)))
        .sort((a, b) => a.kind.localeCompare(b.kind) || b.updated_at - a.updated_at);
      emit(opts.json, rows, () => {
        if (rows.length === 0) return console.log(fmt.muted("Nothing remembered yet."));
        for (const m of rows) {
          const tag = accountTag(accounts, m.account_id);
          const who = m.contact_email ? fmt.accent(m.contact_email) + " " : "";
          console.log(`${fmt.id(m._id)}  ${m.kind.padEnd(10)} ${who}${m.text}${tag ? fmt.muted("  @" + tag) : ""}`);
        }
      });
    },
  );

  const memory = program.command("memory").description("add or remove a memory");
  accountOption(
    memory
      .command("add <text>")
      .description("remember something (a preference, or --contact for something about a person)")
      .option("--contact <email>", "the person this is about"),
  ).action(async (text: string, opts: { contact?: string; account?: string }) => {
    const { accounts } = await session();
    const account = opts.account ? matchAccount(accounts, opts.account) : accounts[0];
    const result = await dispatch("addMemory", { text, contact_email: opts.contact, account_id: account._id });
    console.log(`Remembered ${fmt.id(result.memory_id)}.`);
  });
  memory
    .command("rm <id>")
    .alias("forget")
    .description("forget a memory")
    .action(async (id: string) => {
      const result = await dispatch("deleteMemory", { memory_id: id });
      console.log(result?.deleted ? "Forgotten." : "No such memory.");
    });
}

function byAccount(threads: Thread[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of threads) out.set(t.account_id, [...(out.get(t.account_id) ?? []), t.gmail_id]);
  return out;
}

/** Threads for ids that may no longer be visible; missing ones are skipped. */
async function resolveThreadsLoose(list: string[]): Promise<Thread[]> {
  return (await query(api.sync.threadsByIds, { gmailIds: [...new Set(list)] })) as Thread[];
}
