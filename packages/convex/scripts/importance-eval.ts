// Offline eval for the importance judge. Runs the server's own prompt over
// threads saved from the real mailbox and scores the verdicts.
//
//   mkdir -p /tmp/imp/threads
//   whisk search "newer_than:10d -in:sent -in:drafts -in:spam -in:trash" -n 400 --json \
//     | jq -r '.[].gmail_id' | xargs -P 8 -I{} sh -c 'whisk read {} --json > /tmp/imp/threads/{}.json'
//   cast vault run anthropic -- bun packages/convex/scripts/importance-eval.ts /tmp/imp/threads \
//     [--gold gold.json] [--policy policy.txt] [--model m] [--effort low] [--runs 3] [--out results.json]
//
// Each thread is judged as it stood when its deciding message arrived: the
// first inbound message the person later answered, else the newest inbound
// one. Truth is a gold file ({gmail_id: true|false}, hand labels) when given,
// else behavior: answered or starred = important, anything else = other.
// Several runs show how much of a difference between policies is noise.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMPORTANCE_MODEL, complete, parseJsonReply } from "../convex/ai/llm";
import { readableBody } from "../convex/ai/mailText";
import {
  IMPORTANCE_BATCH,
  IMPORTANCE_SYSTEM,
  importanceInput,
  parseImportanceVerdict,
  type ImportanceRow,
} from "../convex/ai/importance";
import { DEFAULT_IMPORTANCE_POLICY } from "@mail/shared/src/lib/importance";

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
const gold: Record<string, boolean> | null = flag("gold") ? JSON.parse(readFileSync(flag("gold")!, "utf8")) : null;

const mine = (m: Msg) => m.label_ids.includes("SENT");

function snapshot(saved: Saved): { row: ImportanceRow; truth: boolean } | null {
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
  for (let i = 0; i < cases.length; i += IMPORTANCE_BATCH) batches.push(cases.slice(i, i + IMPORTANCE_BATCH));
  let failed = 0;
  const results = await Promise.all(
    batches.map(async (batch) => {
      const text = await complete({
        model,
        system: IMPORTANCE_SYSTEM,
        user: importanceInput({ owner, policy, corrections: [], rows: batch.map((c) => c.row) }),
        maxTokens: 8000,
        effort,
      });
      try {
        const verdicts = parseImportanceVerdict(parseJsonReply(text), batch.length);
        return batch.map((c, i) => ({ ...c, ...verdicts[i] }));
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
const stats = all.map(({ results, failed }) => {
  const tp = results.filter((r) => r.truth && r.important).length;
  const shown = results.filter((r) => r.important).length;
  const truths = results.filter((r) => r.truth).length;
  return { n: results.length, failed, shown, recall: pct(tp, truths), precision: pct(tp, shown), truths };
});
console.log(`model ${model}${effort ? ` (${effort})` : ""} · ${cases.length} threads · ${runs} run(s) · ${((Date.now() - started) / 1000).toFixed(1)}s · truth: ${gold ? "gold labels" : "behavior"}`);
for (const s of stats) console.log(`  shown ${String(s.shown).padStart(3)} of ${s.n}  recall ${s.recall}% of ${s.truths}  precision ${s.precision}%${s.failed ? `  (${s.failed} batches failed)` : ""}`);

const { results } = all[0];
const line = (r: (typeof results)[number]) => `  ${r.row.from.slice(0, 38).padEnd(38)}  ${r.row.subject.slice(0, 58).padEnd(58)}  ${r.why}`;
console.log("\nmissed (truth important, judged other), run 1:");
for (const r of results.filter((r) => r.truth && !r.important)) console.log(line(r));
console.log("\nextra (truth other, judged important), run 1:");
for (const r of results.filter((r) => !r.truth && r.important)) console.log(line(r));
const out = flag("out");
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
