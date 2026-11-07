import type { Command } from "commander";
import { api } from "@mail/convex/convex/_generated/api";
import type { Thread } from "@mail/shared/src/store/types";
import {
  IMPORTANT,
  MAX_LENSES,
  MAX_LENS_NAME,
  clampCutoff,
  inLens,
  lensPolicy,
  newLensId,
  type Lens,
} from "@mail/shared/src/lib/lenses";
import { inGmailInbox } from "@mail/shared/src/store/selectors";
import { fmt } from "../colors";
import { mutation, query } from "../client";
import { currentLenses, dispatch, resolveThreads } from "../mail";
import { emit, ids, jsonOption, plural } from "./shared";

// Views (lenses): inbox lists the person describes in a sentence. The model
// scores every inbox thread on each one and a view shows what scores at or
// above its cutoff. Important is the built-in one; Other is what it leaves
// out. Writes ride the same prefs patch the app sends.

function findLens(lenses: Lens[], wanted: string): Lens {
  const needle = wanted.trim().toLowerCase();
  const lens = lenses.find((l) => l.id === needle || l.name.toLowerCase() === needle);
  if (!lens) throw new Error(`No view named "${wanted}". See: whisk views`);
  return lens;
}

/** Save the whole lens list, and name the lens the server should score
 *  again (its description changed). */
async function saveLenses(lenses: Lens[], rescore?: string): Promise<void> {
  const patches = { client_state: { self: { lenses } } };
  if (rescore) await mutation(api.dispatch.dispatch, { action: "saveLens", args: [{ id: rescore }], patches });
  else await mutation(api.dispatch.dispatch, { action: "setClientPref", args: [], patches });
}

export function registerViews(program: Command): void {
  jsonOption(program.command("views").description("your inbox views: each one's cutoff, how many threads it shows, and its description")).action(async (opts: { json?: boolean }) => {
    const [lenses, page] = await Promise.all([currentLenses(), query(api.sync.listThreads, { limit: 2000 })]);
    const inbox = (page.rows as Thread[]).filter(inGmailInbox);
    const rows = lenses.map((l) => ({
      id: l.id,
      name: l.name,
      cutoff: l.cutoff,
      shown: inbox.filter((t) => inLens(t, l)).length,
      scored: inbox.filter((t) => t.lens_scores?.[l.id] !== undefined).length,
      description: lensPolicy(l),
    }));
    emit(opts.json, rows, () => {
      for (const r of rows) {
        console.log(`${fmt.bold(r.name)}  ${fmt.muted(`${r.shown} shown · cutoff ${r.cutoff} · ${r.scored} of ${inbox.length} scored`)}`);
        console.log(`  ${r.description.split("\n")[0]}`);
      }
      console.log(fmt.muted(`\n${inbox.filter((t) => !inLens(t, lenses[0])).length} under Other`));
    });
  });

  const view = program.command("view").description("add, describe, tune and remove inbox views");
  view.command("add <name> <description...>").description("a new view: what belongs in it, in plain words").action(async (name: string, words: string[]) => {
    const lenses = await currentLenses();
    if (lenses.length >= MAX_LENSES) throw new Error(`Keep it to ${MAX_LENSES} views`);
    if (lenses.some((l) => l.name.toLowerCase() === name.trim().toLowerCase())) throw new Error(`There is already a view named "${name}"`);
    const lens: Lens = { id: newLensId(), name: name.trim().slice(0, MAX_LENS_NAME), policy: words.join(" "), cutoff: clampCutoff(undefined), revision: 1 };
    await saveLenses([...lenses, lens], lens.id);
    console.log(`Added ${lens.name}. Whisk is scoring your recent inbox on it; see it with whisk ls "${lens.name}".`);
  });
  view.command("describe <name> <description...>").description("rewrite what belongs in a view; its recent inbox is scored again").action(async (name: string, words: string[]) => {
    const lenses = await currentLenses();
    const lens = findLens(lenses, name);
    await saveLenses(lenses.map((l) => (l.id === lens.id ? { ...l, policy: words.join(" "), revision: l.revision + 1 } : l)), lens.id);
    console.log(`Rewrote ${lens.name}; scoring its recent inbox again.`);
  });
  view.command("cutoff <name> <score>").description("how much a view shows: threads scoring at or above this (5 to 95; lower shows more)").action(async (name: string, score: string) => {
    const lenses = await currentLenses();
    const lens = findLens(lenses, name);
    const cutoff = clampCutoff(Number(score));
    await saveLenses(lenses.map((l) => (l.id === lens.id ? { ...l, cutoff } : l)));
    console.log(`${lens.name} now shows threads scoring ${cutoff} and up.`);
  });
  view.command("rm <name>").description("remove a view (Important stays)").action(async (name: string) => {
    const lenses = await currentLenses();
    const lens = findLens(lenses, name);
    if (lens.id === IMPORTANT) throw new Error("Important is the inbox itself; describe it instead");
    await saveLenses(lenses.filter((l) => l.id !== lens.id));
    console.log(`Removed ${lens.name}.`);
  });
  for (const [verb, belongs] of [["put", true], ["take", false]] as const) {
    view.command(`${verb} <name> <ids...>`).description(belongs ? "put threads in a view by hand; Whisk learns from it" : "take threads out of a view by hand; Whisk learns from it").action(async (name: string, list: string[]) => {
      const [lenses, threads] = await Promise.all([currentLenses(), resolveThreads(ids(list))]);
      const lens = findLens(lenses, name);
      const byAccount = new Map<string, string[]>();
      for (const t of threads) byAccount.set(t.account_id, [...(byAccount.get(t.account_id) ?? []), t.gmail_id]);
      for (const [account_id, thread_gmail_ids] of byAccount) await dispatch("setLensMark", { thread_gmail_ids, lens_id: lens.id, belongs, account_id });
      console.log(`${belongs ? "Put" : "Took"} ${plural(threads.length, "thread")} ${belongs ? "in" : "out of"} ${lens.name}.`);
    });
  }
}
