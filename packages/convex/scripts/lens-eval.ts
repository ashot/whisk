// Offline eval for the lens judge. Runs the server's own prompt over
// threads saved from the real mailbox and scores Important against hand
// labels at several cutoffs, so the slider's range is measured, not guessed.
//
//   mkdir -p /tmp/imp/threads
//   whisk search "newer_than:10d -in:sent -in:drafts -in:spam -in:trash" -n 400 --json \
//     | jq -r '.[].gmail_id' | xargs -P 8 -I{} sh -c 'whisk read {} --json > /tmp/imp/threads/{}.json'
//   cast vault run anthropic -- bun packages/convex/scripts/lens-eval.ts /tmp/imp/threads --gold gold.json \
//     [--policy policy.txt] [--lens "Name::description"]... [--model m] [--effort low] [--runs 3] [--out results.json]
//
// Each thread is judged as it stood when its deciding message arrived: the
// first inbound message the person later answered, else the newest inbound
// one. Truth is a gold file ({gmail_id: true|false}) when given, else
// behavior: answered or starred = important. Extra --lens lists are scored
// in the same call, the way the server does, and their top threads printed.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMPORTANCE_MODEL, complete, parseJsonReply } from "../convex/ai/llm";
import { readableBody } from "../convex/ai/mailText";
import { LENS_BATCH, LENS_SYSTEM, lensInput, parseLensVerdict, type JudgedLens, type LensRow } from "../convex/ai/lenses";
import { DEFAULT_IMPORTANCE_POLICY, IMPORTANT } from "@mail/shared/src/lib/lenses";

type Msg = {
  from: { name?: string; email: string };
  to: Array<{ email: string }>;
  date: number;
  label_ids: string[];
  body_text?: string;
  snippet: string;
};
type Saved = {
  thread: { gmail_id: string; subject: string; category?: string; has_attachments: boolean; is_starred: boolean };
  messages: Msg[];
};

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dir = argv[0];
if (!dir) throw new Error("usage: importance-eval.ts <threads dir> [--gold f] [--policy f] [--model m] [--runs n] [--out f]");
const model = flag("model") ?? IMPORTANCE_MODEL;
const policy = flag("policy") ? readFileSync(flag("policy")!, "utf8") : DEFAULT_IMPORTANCE_POLICY;
const owner = flag("owner") ?? "ashot@almostcandid.com";
const runs = Number(flag("runs") ?? 1);
const effort = (flag("effort") ?? (flag("model") ? undefined : "low")) as "low" | "medium" | "high" | undefined;
const extra: JudgedLens[] = argv.flatMap((a, i) => (a === "--lens" ? [argv[i + 1]] : [])).map((spec, i) => {
  const [name, description] = spec.split("::");
  return { id: `x${i}`, name, policy: description ?? name };
});
const lenses: JudgedLens[] = [{ id: IMPORTANT, name: "Important", policy }, ...extra];
const gold: Record<string, boolean> | null = flag("gold") ? JSON.parse(readFileSync(flag("gold")!, "utf8")) : null;

const mine = (m: Msg) => m.label_ids.includes("SENT");

function snapshot(saved: Saved): { row: LensRow; truth: boolean } | null {
  const msgs = [...saved.messages].sort((a, b) => a.date - b.date);
  const inbound = msgs.filter((m) => !mine(m));
  if (inbound.length === 0) return null;
  const answered = inbound.find((m) => msgs.some((o) => mine(o) && o.date > m.date));
  const deciding = answered ?? inbound[inbound.length - 1];
  const before = msgs.filter((m) => m.date <= deciding.date);
  const f = deciding.from;
  const id = saved.thread.gmail_id;
  return {
    truth: gold ? gold[id] === true : !!answered || saved.thread.is_starred,
    row: {
      gmail_id: id,
      from: f.name ? `${f.name} <${f.email}>` : f.email,
      to: deciding.to.map((a) => a.email).join(", ").slice(0, 120),
      subject: saved.thread.subject.slice(0, 140),
      lane: saved.thread.category ?? "primary",
      body: readableBody(deciding, 1200),
      has_attachments: saved.thread.has_attachments,
      message_count: before.length,
      i_wrote: before.some(mine),
      gmail_important: deciding.label_ids.includes("IMPORTANT"),
    },
  };
}

const cases = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => snapshot(JSON.parse(readFileSync(join(dir, f), "utf8")) as Saved))
  .filter((c): c is NonNullable<typeof c> => !!c);

async function judgeAll() {
  const batches: Array<typeof cases> = [];
  for (let i = 0; i < cases.length; i += LENS_BATCH) batches.push(cases.slice(i, i + LENS_BATCH));
  let failed = 0;
  const results = await Promise.all(
    batches.map(async (batch) => {
      const text = await complete({
        model,
        system: LENS_SYSTEM,
        user: lensInput({ owner, lenses, corrections: [], rows: batch.map((c) => c.row) }),
        maxTokens: 12000,
        effort,
      });
      try {
        const scores = parseLensVerdict(parseJsonReply(text), batch.length, lenses.map((l) => l.id));
        return batch.map((c, i) => ({ ...c, scores: scores[i] }));
      } catch (error) {
        failed++;
        console.error(`batch failed: ${(error as Error).message}\n${text.slice(0, 400)}`);
        return [];
      }
    }),
  );
  return { results: results.flat(), failed };
}

const started = Date.now();
const all = await Promise.all(Array.from({ length: runs }, judgeAll));
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
console.log(`model ${model}${effort ? ` (${effort})` : ""} · ${cases.length} threads · ${lenses.length} list(s) · ${runs} run(s) · ${((Date.now() - started) / 1000).toFixed(1)}s · truth: ${gold ? "gold labels" : "behavior"}`);
for (const cutoff of [20, 30, 40, 50, 60, 70, 80]) {
  const cells = all.map(({ results }) => {
    const shown = results.filter((r) => r.scores[IMPORTANT].score >= cutoff);
    const tp = shown.filter((r) => r.truth).length;
    return `${String(shown.length).padStart(3)} shown ${String(pct(tp, results.filter((r) => r.truth).length)).padStart(3)}%R ${String(pct(tp, shown.length)).padStart(3)}%P`;
  });
  console.log(`  cutoff ${cutoff}: ${cells.join("  |  ")}`);
}
const failed = all.reduce((n, r) => n + r.failed, 0);
if (failed) console.log(`  (${failed} batches failed)`);

const { results } = all[0];
const line = (r: (typeof results)[number], id: string) => `  ${String(r.scores[id].score).padStart(3)}  ${r.row.from.slice(0, 34).padEnd(34)}  ${r.row.subject.slice(0, 54).padEnd(54)}  ${r.scores[id].why}`;
console.log("\ngold important, by score (run 1):");
for (const r of results.filter((r) => r.truth).sort((a, b) => b.scores[IMPORTANT].score - a.scores[IMPORTANT].score)) console.log(line(r, IMPORTANT));
console.log("\nhighest-scoring gold other (run 1):");
for (const r of results.filter((r) => !r.truth).sort((a, b) => b.scores[IMPORTANT].score - a.scores[IMPORTANT].score).slice(0, 12)) console.log(line(r, IMPORTANT));
for (const l of extra) {
  console.log(`\n${l.name}: top 15 (run 1)`);
  for (const r of [...results].sort((a, b) => b.scores[l.id].score - a.scores[l.id].score).slice(0, 15)) console.log(line(r, l.id));
}
const out = flag("out");
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
