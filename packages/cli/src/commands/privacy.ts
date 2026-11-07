import * as os from "os";
import type { Command } from "commander";
import { api } from "@mail/convex/convex/_generated/api";
import type { Thread } from "@mail/shared/src/store/types";
import {
  MAX_PRIVACY_RULE,
  MAX_PRIVACY_RULES,
  matchedRules,
  newPrivacyRuleId,
  privacyRulesFromPrefs,
  threadPrivacy,
  type PrivacyRule,
} from "@mail/shared/src/lib/privacy";
import { fmt } from "../colors";
import { action, mutation, query } from "../client";
import { dispatch, resolveThreads, session } from "../mail";
import { threadLine } from "../output";
import { emit, ids, jsonOption, plural } from "./shared";

// Private mail: threads agents never see. The person writes a few rules in
// plain words; Whisk's model reads each thread against them, and a hand
// mark beats any rule. Logins for agents (`whisk private token`, or a
// terminal after `whisk private lock`) and connected apps cannot see,
// search, read or act on a private thread, nor one not yet checked. Only
// the person's own logins manage rules and marks.

const MANAGE_ELSEWHERE =
  "This login can't see private mail, so it can't change what's private. The person manages it in Whisk (Settings, Privacy) or from a full login.";

/** Agent login scopes by the words the flag takes. */
const CAN: Record<string, string[]> = {
  read: ["mail.read"],
  draft: ["mail.draft"],
  send: ["mail.send"],
  organize: ["mail.organize"],
  calendar: ["calendar.read", "calendar.write"],
  "calendar-read": ["calendar.read"],
};

async function prefsRules(): Promise<{ rules: PrivacyRule[]; hides: boolean }> {
  const envelope = await query(api.sync.getAccount, {});
  const prefs = (envelope.client_state as { prefs?: Record<string, unknown> } | null)?.prefs;
  return { rules: privacyRulesFromPrefs(prefs), hides: envelope.hides_private };
}

/** The rules, for a command that changes them; refuses an agent login. */
async function editableRules(): Promise<PrivacyRule[]> {
  const { rules, hides } = await prefsRules();
  if (hides) throw new Error(MANAGE_ELSEWHERE);
  return rules;
}

async function saveRules(rules: PrivacyRule[]): Promise<void> {
  await mutation(api.dispatch.dispatch, {
    action: "savePrivacyRules",
    args: [{}],
    patches: { client_state: { self: { privacy_rules: rules } } },
  });
}

/** A rule by its number in `whisk private`, or its id. */
function findRule(rules: PrivacyRule[], wanted: string): PrivacyRule {
  const n = Number(wanted);
  const rule = Number.isInteger(n) && n >= 1 ? rules[n - 1] : rules.find((r) => r.id === wanted);
  if (!rule) throw new Error(`No privacy rule "${wanted}". See: whisk private`);
  return rule;
}

function ruleText(words: string[]): string {
  const text = words.join(" ").trim();
  if (!text) throw new Error("Describe what's private in a few words");
  if (text.length > MAX_PRIVACY_RULE) throw new Error(`Keep a rule under ${MAX_PRIVACY_RULE} characters`);
  return text;
}

/** Hand marks, one dispatch per mailbox. */
async function mark(list: string[], value: boolean | null): Promise<number> {
  if ((await session()).hides_private) throw new Error(MANAGE_ELSEWHERE);
  const threads = await resolveThreads(ids(list));
  const byAccount = new Map<string, string[]>();
  for (const t of threads) byAccount.set(t.account_id, [...(byAccount.get(t.account_id) ?? []), t.gmail_id]);
  let marked = 0;
  for (const [account_id, thread_gmail_ids] of byAccount) {
    const result = await dispatch("setPrivate", { account_id, thread_gmail_ids, private: value });
    marked += result?.marked ?? 0;
  }
  return marked;
}

function reasonFor(t: Thread, rules: PrivacyRule[]): string {
  if (t.private_mark !== undefined) return t.private_mark ? "marked private by you" : "marked not private by you";
  const matched = matchedRules(t, rules);
  if (matched.length === 0) return threadPrivacy(t, rules) === "pending" ? "waiting to be checked" : "no rule applies";
  const which = matched.map((r) => `rule ${rules.indexOf(r) + 1}`).join(", ");
  return t.private_why ? `${which}: ${t.private_why}` : which;
}

export function registerPrivacy(program: Command): void {
  const privacy = program
    .command("private")
    .description("private mail: threads your agents never see, by rules in plain words and by hand");

  jsonOption(privacy).action(async (opts: { json?: boolean }) => {
    const status = await query(api.privacy.status, {});
    emit(opts.json, status, () => {
      if (status.hides_private) {
        console.log(`This login ${fmt.bold("can't see private mail")}.`);
        console.log(
          fmt.muted(
            status.hidden === 0
              ? "Nothing in the mailbox is hidden from it right now."
              : `${plural(status.hidden, "thread")} hidden from it${status.checking ? `, ${status.checking} of them still being checked` : ""}. A thread you can't find may be one of them.`,
          ),
        );
        return;
      }
      if (status.rules.length === 0 && status.marked === 0) {
        console.log("No private mail yet.");
        console.log(fmt.muted(`Add a rule: ${fmt.cmd('whisk private add "anything medical: doctors, prescriptions, insurance claims"')}`));
      } else {
        console.log(
          `${fmt.bold(plural(status.private, "private thread"))}` +
            fmt.muted(`${status.marked ? ` · ${status.marked} marked by hand` : ""}${status.pending ? ` · ${status.pending} still being checked (hidden from agents meanwhile)` : ""}`),
        );
        status.rules.forEach((r, i) => console.log(`  ${fmt.id(String(i + 1))}  ${r.text}  ${fmt.muted(plural(r.threads, "thread"))}`));
        if (!status.ai_configured && status.rules.length > 0) console.log(fmt.warning("The model is not configured on this deployment, so rules cannot be checked: agents see nothing until it is."));
      }
      console.log(fmt.muted(`\nThis terminal sees everything. Agents: ${fmt.cmd("whisk private token <name>")}, or ${fmt.cmd("whisk private lock")} this terminal.`));
    });
  });

  jsonOption(
    privacy
      .command("ls")
      .description("the private threads (and, with --pending, the ones still being checked)")
      .option("--pending", "also the threads still waiting to be checked")
      .option("-n, --limit <n>", "how many", "50"),
  ).action(async (opts: { json?: boolean; pending?: boolean; limit: string }) => {
    const [{ rules, hides }, page, s] = await Promise.all([prefsRules(), query(api.sync.listThreads, { limit: 2000 }), session()]);
    if (hides) throw new Error("This login can't see private mail.");
    const rows = (page.rows as Thread[])
      .filter((t) => !t.deleted && t.message_count > 0)
      .filter((t) => {
        const state = threadPrivacy(t, rules);
        return state === "private" || (opts.pending && state === "pending");
      })
      .sort((a, b) => b.last_at - a.last_at)
      .slice(0, Number(opts.limit) || 50);
    emit(opts.json, rows.map((t) => ({ ...t, privacy: threadPrivacy(t, rules), reason: reasonFor(t, rules) })), () => {
      if (rows.length === 0) console.log(fmt.muted("No private threads."));
      for (const t of rows) {
        console.log(threadLine(t, s.accounts));
        console.log(fmt.muted(`    ${reasonFor(t, rules)}`));
      }
    });
  });

  jsonOption(privacy.command("why <id>").description("whether a thread is private, and why")).action(async (id: string, opts: { json?: boolean }) => {
    const { rules, hides } = await prefsRules();
    if (hides) throw new Error("This login can't see private mail.");
    const [t] = await resolveThreads([id]);
    const state = threadPrivacy(t, rules);
    emit(opts.json, { gmail_id: t.gmail_id, privacy: state, reason: reasonFor(t, rules), rules: matchedRules(t, rules) }, () => {
      const label = state === "private" ? fmt.warning("private") : state === "pending" ? fmt.muted("being checked (hidden from agents)") : fmt.success("visible to agents");
      console.log(`${fmt.id(t.gmail_id)}  ${t.subject || "(no subject)"}\n  ${label}  ${fmt.muted(reasonFor(t, rules))}`);
      for (const r of matchedRules(t, rules)) console.log(fmt.muted(`  rule ${rules.indexOf(r) + 1}: ${r.text}`));
    });
  });

  jsonOption(
    privacy.command("preview <text...>").description("which of your recent threads a rule would make private (changes nothing)").option("-n, --limit <n>", "how many recent threads per mailbox to check", "100"),
  ).action(async (words: string[], opts: { json?: boolean; limit: string }) => {
    if ((await session()).hides_private) throw new Error(MANAGE_ELSEWHERE);
    const hits = await action(api.ai.privacy.previewPrivacy, { text: ruleText(words), limit: Number(opts.limit) || 100 });
    emit(opts.json, hits, () => {
      if (hits.length === 0) {
        console.log(fmt.muted(`None of your ${opts.limit} most recent threads fall under it.`));
        return;
      }
      console.log(fmt.bold(`${plural(hits.length, "thread")} would be private:`));
      for (const h of hits) console.log(`  ${fmt.id(h.thread_gmail_id)}  ${h.subject || "(no subject)"}  ${fmt.muted(`${h.from} · ${h.why}`)}`);
      console.log(fmt.muted(`\nKeep it: whisk private add ${JSON.stringify(words.join(" "))}`));
    });
  });

  privacy.command("add <text...>").description("a rule: what is private, in plain words").action(async (words: string[]) => {
    const rules = await editableRules();
    if (rules.length >= MAX_PRIVACY_RULES) throw new Error(`Keep it to ${MAX_PRIVACY_RULES} rules`);
    const text = ruleText(words);
    if (rules.some((r) => r.text.toLowerCase() === text.toLowerCase())) throw new Error("That rule is already there");
    await saveRules([...rules, { id: newPrivacyRuleId(), text, revision: 1, created_at: Date.now() }]);
    console.log(`Added rule ${rules.length + 1}. Whisk is checking your mail against it; agents see no thread until it has been checked.`);
  });

  privacy.command("edit <rule> <text...>").description("reword a rule (by its number in whisk private); mail is checked again").action(async (wanted: string, words: string[]) => {
    const rules = await editableRules();
    const rule = findRule(rules, wanted);
    const text = ruleText(words);
    await saveRules(rules.map((r) => (r.id === rule.id ? { ...r, text, revision: r.revision + 1 } : r)));
    console.log(`Reworded rule ${rules.indexOf(rule) + 1}; checking your mail against it again.`);
  });

  privacy.command("rm <rule>").description("remove a rule; what only it kept private becomes visible to agents").action(async (wanted: string) => {
    const rules = await editableRules();
    const rule = findRule(rules, wanted);
    await saveRules(rules.filter((r) => r.id !== rule.id));
    console.log(`Removed: ${rule.text}`);
  });

  privacy.command("mark <ids...>").description("make threads private by hand, whatever the rules say").action(async (list: string[]) => {
    console.log(`Marked ${plural(await mark(list, true), "thread")} private.`);
  });
  privacy.command("unmark <ids...>").description("make threads visible to agents by hand, whatever the rules say").action(async (list: string[]) => {
    console.log(`Marked ${plural(await mark(list, false), "thread")} not private.`);
  });
  privacy.command("reset <ids...>").description("hand threads back to the rules").action(async (list: string[]) => {
    console.log(`${plural(await mark(list, null), "thread")} back to the rules; checking again.`);
  });

  privacy
    .command("token <name>")
    .description("a login for an agent: it never sees private mail and cannot change what's private")
    .option("--can <what>", `what it may do: ${Object.keys(CAN).join(", ")} (comma separated; default all)`)
    .action(async (name: string, opts: { can?: string }) => {
      if ((await session()).hides_private) throw new Error(MANAGE_ELSEWHERE);
      let scopes: string[] | undefined;
      if (opts.can) {
        scopes = [];
        for (const word of opts.can.split(/[\s,]+/).filter(Boolean)) {
          const s = CAN[word.toLowerCase()];
          if (!s) throw new Error(`--can takes ${Object.keys(CAN).join(", ")}; not "${word}"`);
          scopes.push(...s);
        }
      }
      const minted = await mutation(api.devices.mint, {
        device_name: `${name.trim().slice(0, 60)} (agent, ${os.hostname()})`,
        hides_private: true,
        scopes: scopes as any,
      });
      console.log(`Agent login for ${fmt.bold(name)}. It is shown once:\n\n  ${minted.token}\n`);
      console.log(fmt.muted("Give it to the agent's environment as WHISK_TOKEN, or run `whisk login <token>` there."));
      console.log(fmt.muted("It never sees private mail. End it with: whisk devices revoke <id> (see whisk devices)."));
    });

  privacy
    .command("lock")
    .description("stop this terminal from seeing private mail (undo only from the Whisk app)")
    .option("--yes", "yes, lock it")
    .action(async (opts: { yes?: boolean }) => {
      if ((await session()).hides_private) {
        console.log("This terminal already can't see private mail.");
        return;
      }
      if (!opts.yes) {
        console.log("Agents on this machine use this terminal's login. Locking it hides private mail from them and from you here,");
        console.log("and stops this login changing what's private. Only the Whisk app (Settings, Terminals) can unlock it.");
        console.log(`\nRun ${fmt.cmd("whisk private lock --yes")} to lock it.`);
        return;
      }
      await mutation(api.devices.lock, {});
      console.log("Locked. This terminal no longer sees private mail.");
    });
}
