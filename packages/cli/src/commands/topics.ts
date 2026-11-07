import type { Command } from "commander";
import type { Id } from "@mail/convex/convex/_generated/dataModel";
import { api } from "@mail/convex/convex/_generated/api";
import { query, action, mutation } from "../client";
import { OPS, applyToThreads, dispatch, matchAccount, session, resolveThreads } from "../mail";
import { accountOption, jsonOption } from "./shared";
import { accountTag, threadLine } from "../output";
import { relativeDate } from "@mail/shared/src/lib/format";
import { topicTree } from "@mail/shared/src/store/selectors";
import type { Pile } from "@mail/shared/src/store/selectors";
import type { Cluster, Thread, Filter } from "@mail/shared/src/store/types";

type Options = { account?: string; json?: boolean };
async function accountId(opts: Options) {
  const { accounts } = await session();
  if (!opts.account && accounts.length > 1) throw new Error("Choose a mailbox with --account");
  return (opts.account ? matchAccount(accounts, opts.account) : accounts[0])._id;
}
/** A topic by id or by name; a name shared across mailboxes needs the id. */
async function topic(wanted: string): Promise<Cluster> {
  const rows = (await query(api.clusters.listClusters, {})).filter(c => !c.deleted && (c._id === wanted || c.name.toLowerCase() === wanted.toLowerCase()));
  if (rows.length === 0) throw new Error(`No topic named "${wanted}" (see whisk topics)`);
  if (rows.length > 1) {
    const { accounts } = await session();
    throw new Error(`"${wanted}" names ${rows.length} topics (${rows.map(c => accounts.find(a => a._id === c.account_id)?.email ?? c.account_id).join(", ")}); use the id from whisk topics`);
  }
  return rows[0];
}
async function filter(wanted: string): Promise<Filter> {
  const rows = (await query(api.filters.listFilters, {})).filter(f => !f.deleted && f._id === wanted);
  if (!rows[0]) throw new Error("No such filter (whisk filters)");
  return rows[0];
}
export function registerTopics(program: Command) {
  jsonOption(accountOption(program.command("topics").description("the inbox's themes, the topics in each, and the topics in no theme"))).action(async (opts: Options) => {
    const [clusters, page] = await Promise.all([query(api.clusters.listClusters, {}), query(api.sync.listThreads, { limit: 2000 })]);
    const scope = opts.account ? await accountId(opts) : "all";
    const tree = topicTree(Object.fromEntries(page.rows.map(t => [t._id, t as Thread])), Object.fromEntries(clusters.map(c => [c._id, c])), scope);
    const { accounts } = await session();
    const many = accounts.length > 1 && scope === "all";
    const row = (p: Pile, depth: number) => { const c = p.meta.cluster!; return { id: p.meta.id, account_id: c.account_id, account: accounts.find(a => a._id === c.account_id)?.email, name: p.meta.name, description: p.meta.hint, theme: c.kind === "theme", depth, muted: !!c.hidden, mine: c.source === "user", count: p.threads.length, unread: p.unread, subjects: p.threads.slice(0, 5).map(t => t.subject) }; };
    const rows = [...tree.themes.flatMap(n => [row(n.pile, 0), ...n.streams.map(p => row(p, 1))]), ...tree.loose.map(p => row(p, 0))];
    const grouping = accounts.filter(a => a.clustering).map(a => `Grouping ${a.email}${a.cluster_progress ? ` · ${a.cluster_progress.tidy ? "sorting into themes" : `${a.cluster_progress.review ? "second look " : ""}${a.cluster_progress.done}/${a.cluster_progress.total}`}` : ""}`);
    const errors = accounts.filter(a => a.cluster_error).map(a => `! ${a.email}: ${a.cluster_error}`);
    console.log(opts.json ? JSON.stringify(rows, null, 2) : [
      ...grouping, ...errors,
      ...rows.map(r => `${r.depth ? "    " : ""}${r.id}  ${String(r.count).padStart(4)}${r.unread ? `  ${String(r.unread).padStart(4)} unread` : "           "}  ${r.name}${r.theme ? "  (theme)" : ""}${r.mine ? "  (yours)" : ""}${r.muted ? "  (muted)" : ""}${many ? `  [${r.account}]` : ""}${r.depth ? "" : `\n    ${r.description}`}`),
    ].join("\n") || "No topics yet. Run whisk topic regroup --account <mailbox>.");
  });
  const cmd = program.command("topic").description("create, correct and regroup semantic topics");
  cmd.command("settings").description("auto-grouping and detail level, the same switches as Settings").option("--auto <on|off>", "group new mail as it arrives").option("--detail <fewer|balanced|more>", "how finely topics split on the next regroup").action(async (opts: { auto?: string; detail?: string }) => {
    const clustering: Record<string, unknown> = {};
    if (opts.auto !== undefined) { if (!["on", "off"].includes(opts.auto)) throw new Error("--auto takes on or off"); clustering.enabled = opts.auto === "on"; }
    if (opts.detail !== undefined) { if (!["fewer", "balanced", "more"].includes(opts.detail)) throw new Error("--detail takes fewer, balanced or more"); clustering.granularity = opts.detail; }
    const state = (await query(api.sync.getAccount, {})).client_state as { prefs?: { clustering?: Record<string, unknown> } } | null;
    const current = { enabled: true, granularity: "balanced", ...state?.prefs?.clustering };
    if (Object.keys(clustering).length === 0) { console.log(`auto ${current.enabled === false ? "off" : "on"} · detail ${current.granularity}`); return; }
    // Preferences ride the same patch rail the web uses; `clustering` is
    // an open pref, so it lands in prefs without a schema change.
    await mutation(api.dispatch.dispatch, { action: "setClientPref", args: [], patches: { client_state: { self: { clustering: { ...current, ...clustering } } } } });
    console.log(`auto ${(clustering.enabled ?? current.enabled) === false ? "off" : "on"} · detail ${clustering.granularity ?? current.granularity}${clustering.granularity ? "  (takes effect on the next regroup: whisk topic regroup --fresh)" : ""}`);
  });
  accountOption(cmd.command("regroup").description("group new mail now; --fresh starts over").option("--fresh", "rediscover topics; pinned topics and your placements stay")).action(async (opts: Options & { fresh?: boolean }) => { await dispatch("regroupClusters", { account_id: await accountId(opts), fresh: !!opts.fresh }); console.log(`Grouping scheduled${opts.fresh ? " from scratch" : ""}; watch it with whisk status.`); });
  jsonOption(accountOption(cmd.command("show <topic>").description("the inbox conversations in a topic; `none` lists inbox mail without one"))).action(async (wanted: string, opts: Options) => {
    const page = await query(api.sync.listThreads, { limit: 2000 });
    const c = wanted === "none" ? null : await topic(wanted);
    const scope = c ? c.account_id : opts.account ? await accountId(opts) : "all";
    const rows = page.rows.filter(t => !t.deleted && t.label_ids.includes("INBOX") && (scope === "all" || t.account_id === scope) && (c ? t.cluster_id === c._id : !t.cluster_id));
    console.log(opts.json ? JSON.stringify({ topic: c, threads: rows }, null, 2) : rows.map(t => `${t.gmail_id}  ${t.subject}`).join("\n") || (c ? "Nothing in this topic right now." : "Everything in the inbox has a topic."));
  });
  accountOption(cmd.command("create <name> [ids...]").description("make a topic of your own, with any conversations given")).action(async (name: string, ids: string[], opts: Options) => {
    const account_id = await accountId(opts);
    const rows = ids.length ? await resolveThreads(ids) : [];
    if (rows.some(t => t.account_id !== account_id)) throw new Error("All threads must belong to the chosen mailbox");
    const result = await dispatch("createCluster", { name, account_id, thread_gmail_ids: rows.map(t => t.gmail_id) }) as { cluster_id: string; placed: number };
    console.log(`Created “${name}” (${result.cluster_id})${result.placed ? ` with ${result.placed} conversation${result.placed === 1 ? "" : "s"}` : ""}.`);
  });
  cmd.command("move <topic> <ids...>").action(async (wanted: string, ids: string[]) => {
    const c = wanted === "none" ? null : await topic(wanted), rows = await resolveThreads(ids);
    if (c && rows.some(t => t.account_id !== c.account_id)) throw new Error("All threads must belong to the topic’s mailbox");
    for (const account_id of new Set(rows.map(t => t.account_id))) await dispatch("setThreadCluster", { account_id, cluster_id: c?._id ?? null, thread_gmail_ids: rows.filter(t => t.account_id === account_id).map(t => t.gmail_id) });
    console.log(`Moved ${rows.length} conversations.`);
  });
  cmd.command("rename <topic> <name>").description("rename a topic (id or name); --description sets what belongs in it").option("--description <text>").action(async (wanted: string, name: string, opts: { description?: string }) => { const c = await topic(wanted); await dispatch("renameCluster", { cluster_id: c._id, account_id: c.account_id, name, description: opts.description }); console.log(`Renamed “${c.name}” to “${name}”${opts.description ? " and updated its description" : ""}.`); });
  cmd.command("file <topic> <theme|none>").description("put a topic in a theme, or take it out with none").action(async (wanted: string, where: string) => { const c = await topic(wanted); const t = where === "none" ? null : await topic(where); if (t && t.kind !== "theme") throw new Error(`“${t.name}” is not a theme`); await dispatch("renameCluster", { cluster_id: c._id, account_id: c.account_id, parent_id: t?._id ?? null }); console.log(t ? `“${c.name}” is now part of “${t.name}”.` : `“${c.name}” stands on its own.`); });
  cmd.command("merge <from> <into>").description("fold one topic into another").action(async (from: string, into: string) => { const a = await topic(from), b = await topic(into); if (a.account_id !== b.account_id) throw new Error("Topics must be in the same mailbox"); const result = await dispatch("mergeClusters", { from_ids: [a._id], into_id: b._id, account_id: b.account_id }) as { moved?: number }; console.log(`Merged “${a.name}” into “${b.name}”${result?.moved !== undefined ? ` (${result.moved} conversations)` : ""}; “${b.name}” is now yours.`); });
  cmd.command("hide <topic>").description("take a topic out of the inbox list without archiving its mail").action(async (wanted: string) => {
    const c = await topic(wanted);
    await dispatch("setClusterTreatment", { cluster_id: c._id, account_id: c.account_id, hidden: true, archive_new: false });
    console.log(`Hidden “${c.name}” — it is out of the inbox list; its mail stays.`);
  });
  cmd.command("unhide <topic>").description("put a hidden topic back in the inbox list").action(async (wanted: string) => {
    const c = await topic(wanted);
    await dispatch("setClusterTreatment", { cluster_id: c._id, account_id: c.account_id, hidden: false, archive_new: false });
    console.log(`“${c.name}” is back in the inbox.`);
  });
  cmd.command("mute <topic>").description("archive everything in a topic now and keep new mail in it out of the inbox").action(async (wanted: string) => {
    const c = await topic(wanted);
    await dispatch("setClusterTreatment", { cluster_id: c._id, account_id: c.account_id, hidden: true, archive_new: true });
    const page = await query(api.sync.listThreads, { limit: 2000 });
    const tree = topicTree(Object.fromEntries(page.rows.map(t => [t._id, t as Thread])), Object.fromEntries((await query(api.clusters.listClusters, {})).map(x => [x._id, x])), c.account_id);
    const pile = tree.themes.find(n => n.pile.meta.id === c._id)?.pile ?? tree.themes.flatMap(n => n.streams).find(p => p.meta.id === c._id) ?? tree.loose.find(p => p.meta.id === c._id);
    const rows = pile?.threads ?? [];
    if (rows.length) await applyToThreads(rows, [...OPS.archive.add], [...OPS.archive.remove]);
    console.log(`Muted “${c.name}”: archived ${rows.length} conversation${rows.length === 1 ? "" : "s"}; new mail in it skips the inbox.`);
  });
  cmd.command("unmute <topic>").description("let a muted topic's new mail land in the inbox again").action(async (wanted: string) => { const c = await topic(wanted); await dispatch("setClusterTreatment", { cluster_id: c._id, account_id: c.account_id, hidden: false, archive_new: false }); console.log(`“${c.name}” is back in the inbox; new mail in it stays.`); });
  cmd.command("dissolve <topic>").description("take a topic apart; its conversations stay in the inbox, a theme's topics stand on their own").action(async (wanted: string) => { const c = await topic(wanted); const result = await dispatch("dissolveCluster", { cluster_id: c._id, account_id: c.account_id }) as { freed?: number }; console.log(`Took “${c.name}” apart; ${result?.freed ?? "its"} conversations stay in the inbox.`); });
  jsonOption(accountOption(program.command("filters").description("natural-language filters and their health"))).action(async (opts: Options) => {
    const scope = opts.account ? await accountId(opts) : undefined;
    const { accounts } = await session();
    const rows = (await query(api.filters.listFilters, {})).filter(f => !f.deleted && (!scope || f.account_id === scope));
    console.log(opts.json ? JSON.stringify(rows, null, 2) : rows.map(f => {
      const tag = accountTag(accounts, f.account_id);
      const head = `${f._id}  ${f.enabled ? "on    " : "paused"}  ${String(f.hits).padStart(3)} hits  ${f.last_checked_at ? `checked ${relativeDate(f.last_checked_at)}` : "not checked yet"}${tag ? `  [${tag}]` : ""}`;
      return [head, `    ${f.text}`, ...(f.last_error ? [`    ! ${f.last_error}`] : [])].join("\n");
    }).join("\n") || "No filters.");
  });
  const fc = program.command("filter").description("LLM conditions with reviewed, fixed actions");
  for (const verb of ["preview", "add"] as const) jsonOption(accountOption(fc.command(`${verb} <text>`).option("--apply", verb === "add" ? "also run the actions on the conversations a preview matches now" : "same as preview"))).action(async (text: string, opts: Options & { apply?: boolean }) => {
    const account_id = await accountId(opts), parsed = await action(api.ai.actions.parseFilter, { accountId: account_id as Id<"accounts">, text });
    // Applying now touches exactly the previewed matches, as the web does.
    const matches = verb === "preview" || opts.apply ? await action(api.ai.actions.previewFilter, { accountId: account_id as Id<"accounts">, condition: parsed.condition }) : undefined;
    if (verb === "preview") {
      const rows = matches?.length ? await resolveThreads(matches) : [];
      if (opts.json) return console.log(JSON.stringify({ ...parsed, matches: rows.map(t => ({ gmail_id: t.gmail_id, subject: t.subject, participants: t.participants })) }, null, 2));
      const { accounts } = await session();
      console.log(`Reading: ${parsed.condition}\nActions: ${parsed.actions.map(a => a.arg ? `${a.kind} ${a.arg}` : a.kind).join(", ")}\n${rows.length} of the last 200 inbox conversations match. Nothing changed.`);
      for (const t of rows) console.log(threadLine(t, accounts));
      return;
    }
    const saved = await dispatch("saveFilter", { account_id, text, ...parsed, apply_now: !!opts.apply, thread_gmail_ids: opts.apply ? matches : undefined }) as { filter_id: string; summary: string };
    if (opts.json) return console.log(JSON.stringify({ ...saved, ...parsed, applied_to: opts.apply ? matches : undefined }, null, 2));
    console.log(`Filter saved for new mail (${saved.filter_id}): ${saved.summary}${opts.apply ? `\nApplying to ${matches?.length ?? 0} previewed conversation${matches?.length === 1 ? "" : "s"} now.` : ""}`);
  });
  jsonOption(fc.command("edit <id> <text>").description("reword a filter; it stays paused if it was paused")).action(async (id: string, text: string, opts: { json?: boolean }) => {
    const f = await filter(id);
    const parsed = await action(api.ai.actions.parseFilter, { accountId: f.account_id as Id<"accounts">, text });
    const saved = await dispatch("saveFilter", { filter_id: f._id, account_id: f.account_id, text, ...parsed }) as { summary: string };
    console.log(opts.json ? JSON.stringify({ ...saved, ...parsed }, null, 2) : `Filter updated: ${parsed.condition}\nActions: ${saved.summary}`);
  });
  fc.command("pause <id>").action(async (id: string) => { const f = await filter(id); await dispatch("setFilterEnabled", { filter_id: f._id, account_id: f.account_id, enabled: false }); console.log("Filter paused; it no longer reads new mail."); });
  fc.command("resume <id>").alias("enable").action(async (id: string) => { const f = await filter(id); await dispatch("setFilterEnabled", { filter_id: f._id, account_id: f.account_id, enabled: true }); console.log("Filter resumed; it reads new mail again."); });
  fc.command("rm <id>").description("delete a filter; mail it already acted on stays as it is").action(async (id: string) => { const f = await filter(id); await dispatch("deleteFilter", { filter_id: f._id, account_id: f.account_id }); console.log("Filter deleted."); });
  fc.command("run <id>").description("run the actions on up to 300 recent inbox conversations").option("--yes", "confirm: this changes existing mail").action(async (id: string, opts: { yes?: boolean }) => {
    const f = await filter(id);
    if (!opts.yes) throw new Error("Running a filter on existing mail changes it. Add --yes to run on up to 300 recent inbox conversations.");
    await dispatch("runFilters", { filter_id: f._id, account_id: f.account_id });
    console.log("Checking up to 300 recent inbox conversations against this filter; matches act within a minute.");
  });
}
