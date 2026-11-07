import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { mailReader, visibleClusterIds } from "./lib/privacy";
import { SYSTEM_LABEL_IDS } from "./lib/threads";
import { THREAD_WINDOW } from "./lib/rows";
import { modifyThreadLabels, schedulePump } from "./lib/outbound";
import type { LooseSender, ThemeRow, ThemeStream } from "./ai/grouping";

type OutboundCtx = Parameters<typeof schedulePump>[0];

// Topic clusters: the read side, the candidate feed the model clusters from,
// and the write path that lands its verdicts. The model call itself lives in
// ai/actions.ts (Node runtime). Controls a person uses — rename, merge,
// dissolve, mute, move a thread — are dispatch side effects that call the
// helpers exported here, so a hand gesture and a model verdict write rows
// the same way.

/** Read side of a ctx: queries and mutations both qualify. */
type ReadCtx = { db: QueryCtx["db"] };
type WriteCtx = { db: MutationCtx["db"] };

/** The person's own topic: made, renamed, merged, moved or muted by hand
 *  (older rows say it with `pinned`). The model never folds, renames or
 *  dissolves one, and never moves mail out of it. */
export function isMine(c: { source: string; pinned?: boolean }): boolean {
  return c.pinned === true || c.source === "user";
}

export function isTheme(c: { kind?: string }): boolean {
  return c.kind === "theme";
}

export const listClusters = query({
  args: { token: v.optional(v.string()), since: v.optional(v.number()) },
  handler: async (ctx, { token, since }) => {
    const reader = await mailReader(ctx, token);
    const out = [];
    for (const account of reader.accounts) {
      const rows = await ctx.db
        .query("clusters")
        .withIndex("by_account", (q) =>
          since === undefined
            ? q.eq("account_id", account._id)
            : q.eq("account_id", account._id).gt("updated_at", since),
        )
        .collect();
      if (!reader.hidesPrivate) {
        out.push(...rows);
        continue;
      }
      const visible = await visibleClusterIds(ctx, account._id, reader.sees);
      for (const row of rows) {
        // A removed topic still carries its name; such a reader gets only
        // the fact that it is gone.
        if (row.deleted) out.push({ ...row, name: "", description: "" });
        else if (visible.has(row._id)) out.push(row);
      }
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** How long a sync waits before clustering what it landed, so a burst of
 *  syncs (a backfill, a busy morning) costs one model pass, not one per page. */
export const CLUSTER_DEBOUNCE_MS = 20_000;

type SchedCtx = { db: MutationCtx["db"]; scheduler: MutationCtx["scheduler"] };

export async function scheduleClustering(
  ctx: SchedCtx,
  account: Doc<"accounts">,
  opts: { delayMs?: number; fresh?: boolean } = {},
): Promise<void> {
  if (account.cluster_job) {
    const job = await ctx.db.system.get(account.cluster_job);
    if (job?.state.kind === "pending" || job?.state.kind === "inProgress") {
      if (opts.fresh) throw new Error("Grouping is already running. Try again when it finishes.");
      if (account.cluster_started_at) await ctx.db.patch(account._id, { cluster_dirty: true });
      return;
    }
  }
  const job = await ctx.scheduler.runAfter(
    opts.delayMs ?? CLUSTER_DEBOUNCE_MS,
    internal.ai.actions.clusterInbox,
    { accountId: account._id, fresh: opts.fresh ?? false },
  );
  await ctx.db.patch(account._id, { cluster_job: job, cluster_error: undefined });
}

/** How often an incremental pass re-offers recent mail the model once left
 *  without a topic, so a topic can form from threads that arrived one at a
 *  time without every new thread re-reading the whole backlog. */
export const REVISIT_EVERY_MS = 6 * 3600 * 1000;

/** A run older than this with no finish is dead (the runtime killed the
 *  action, or a deploy replaced it): its pulse comes down so the sweep stops
 *  claiming to be busy and a regroup can start. */
export const STALE_RUN_MS = 30 * 60 * 1000;

export const sweepStaleRuns = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let cleared = 0;
    for await (const account of ctx.db.query("accounts")) {
      if (!account.cluster_job && !account.cluster_started_at) continue;
      const job = account.cluster_job ? await ctx.db.system.get(account.cluster_job) : null;
      const live = job?.state.kind === "pending" || job?.state.kind === "inProgress";
      const old = (account.cluster_started_at ?? now) < now - STALE_RUN_MS;
      if (live && !old) continue;
      await ctx.db.patch(account._id, {
        cluster_job: undefined, cluster_started_at: undefined, cluster_dirty: undefined, cluster_progress: undefined,
        cluster_error: live ? "Grouping ran too long and was stopped. Your existing topics are kept. Regroup to try again." : account.cluster_error,
        updated_at: now,
      });
      if (live && account.cluster_job) await ctx.scheduler.cancel(account.cluster_job);
      cleared++;
    }
    return { cleared };
  },
});

export const beginPass = internalMutation({
  args: { accountId: v.id("accounts"), startedAt: v.optional(v.number()) },
  handler: async (ctx, { accountId, startedAt: previous }) => {
    const account = await ctx.db.get(accountId);
    if (!account || (previous !== undefined && account.cluster_started_at !== previous) || !(await clusteringSettings(ctx, account)).enabled) return { ok: false, startedAt: 0, revisit: false };
    if (previous !== undefined) return { ok: true, startedAt: previous, revisit: false };
    const startedAt = Date.now();
    const revisit = startedAt - (account.cluster_revisited_at ?? 0) >= REVISIT_EVERY_MS;
    await ctx.db.patch(accountId, { cluster_started_at: startedAt, cluster_dirty: undefined, cluster_progress: undefined, updated_at: startedAt, ...(revisit ? { cluster_revisited_at: startedAt } : {}) });
    return { ok: true, startedAt, revisit };
  },
});

// ---------------------------------------------------------------------------
// What the model reads
// ---------------------------------------------------------------------------

/** Rows the model clusters from: inbox threads that are unjudged, plus (to
 *  let a topic form out of mail that arrived one thread at a time) recent
 *  threads it judged as fitting nothing. Newest first. */
export const finishPass = internalMutation({
  args: { accountId: v.id("accounts"), startedAt: v.number(), error: v.optional(v.string()) },
  handler: async (ctx, { accountId, startedAt, error }) => {
    const account = await ctx.db.get(accountId);
    if (!account || (startedAt && account.cluster_started_at !== startedAt)) return;
    await ctx.db.patch(accountId, { cluster_job: undefined, cluster_started_at: undefined, cluster_dirty: undefined, cluster_progress: undefined, cluster_error: error, updated_at: Date.now() });
    if (!error && account.cluster_dirty && (await clusteringSettings(ctx, account)).enabled) await scheduleClustering(ctx, { ...account, cluster_job: undefined });
  },
});

export const candidates = internalQuery({
  args: {
    accountId: v.id("accounts"),
    limit: v.number(),
    /** Include threads already judged "no cluster" (newer than this stamp). */
    revisitSince: v.optional(v.number()),
    fresh: v.optional(v.boolean()),
    skip: v.optional(v.array(v.string())),
    only: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { accountId, limit, revisitSince, fresh: regroup, skip, only }) => {
    const skipped = new Set(skip ?? []);
    const included = only ? new Set(only) : null;
    const protectedIds = new Set((await liveClusters(ctx, accountId)).filter(isMine).map(c => String(c._id)));
    const fresh: ClusterCandidate[] = [];
    const revisit: ClusterCandidate[] = [];
    let scanned = 0;
    for await (const t of ctx.db
      .query("threads")
      .withIndex("by_account_last", (q) => q.eq("account_id", accountId))
      .order("desc")) {
      if (++scanned > CANDIDATE_SCAN_CAP) break;
      if (!inInbox(t) || (included && !included.has(t.gmail_id))) continue;
      if (t.cluster_source === "user" || skipped.has(t.gmail_id) || (t.cluster_id && protectedIds.has(t.cluster_id))) continue;
      const row = candidateRow(t);
      if (regroup || !t.cluster_source) {
        fresh.push(row);
      } else if (!t.cluster_id && revisitSince !== undefined && t.last_at >= revisitSince) {
        revisit.push(row);
      }
      if (fresh.length >= limit) break;
    }
    return [...fresh, ...revisit].slice(0, limit);
  },
});

/** How deep into the inbox one pass looks: exactly as deep as the app shows,
 *  so a topic's size on a card is its whole size. */
const CANDIDATE_SCAN_CAP = THREAD_WINDOW;

export type ClusterCandidate = {
  gmail_id: string;
  from: string;
  subject: string;
  snippet: string;
  lane: string;
  cluster_id?: Id<"clusters">;
};

function candidateRow(t: Doc<"threads">): ClusterCandidate {
  const starter = t.participants[0];
  const from = starter
    ? starter.name
      ? `${starter.name} <${starter.email}>`
      : starter.email
    : "";
  return {
    gmail_id: t.gmail_id,
    from,
    subject: t.subject.slice(0, 180),
    snippet: t.snippet.slice(0, 300),
    lane: t.category ?? "primary",
    cluster_id: t.cluster_id,
  };
}

function inInbox(t: Doc<"threads">): boolean {
  return (
    !t.deleted &&
    t.label_ids.includes(SYSTEM_LABEL_IDS.INBOX) &&
    !t.label_ids.includes(SYSTEM_LABEL_IDS.TRASH) &&
    !t.label_ids.includes(SYSTEM_LABEL_IDS.SPAM)
  );
}

/** The live streams with their inbox sizes, plus the owner's clustering
 *  preferences and the granularity setting — everything the batch prompt
 *  needs besides the candidates. Themes are not offered: mail joins a
 *  stream, and the theme pass files streams. */
export const roster = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const clusters = (await liveClusters(ctx, accountId)).filter((c) => !isTheme(c)).map((c) => ({
      _id: c._id,
      name: c.name,
      description: c.description,
      pinned: isMine(c),
      source: c.source,
      created_at: c.created_at,
      updated_at: c.updated_at,
      size: 0,
    }));
    const sizes = new Map(clusters.map((c) => [c._id, c]));
    let scanned = 0;
    for await (const t of ctx.db
      .query("threads")
      .withIndex("by_account_last", (q) => q.eq("account_id", accountId))
      .order("desc")) {
      if (++scanned > CANDIDATE_SCAN_CAP) break;
      if (!t.cluster_id || !inInbox(t)) continue;
      const c = sizes.get(t.cluster_id);
      if (c) c.size++;
    }
    const memories = await ctx.db
      .query("memories")
      .withIndex("by_account", (q) => q.eq("account_id", accountId))
      .collect();
    const preferences = memories
      .filter((m) => m.kind === "preference" && !m.deleted)
      .map((m) => m.text);
    const account = await ctx.db.get(accountId);
    const settings = await clusteringSettings(ctx, account);
    return { clusters, preferences, ...settings };
  },
});

export type ClusteringSettings = {
  enabled: boolean;
  granularity: "fewer" | "balanced" | "more";
};

/** The person's clustering preferences, from client_state.prefs.clustering.
 *  Absent = on, balanced. */
export async function clusteringSettings(
  ctx: ReadCtx,
  account: Doc<"accounts"> | null,
): Promise<ClusteringSettings> {
  const state = account?.user_id
    ? await ctx.db
        .query("client_state")
        .withIndex("by_user", (q) => q.eq("user_id", account.user_id))
        .unique()
    : null;
  const prefs = (state?.prefs as { clustering?: Partial<ClusteringSettings> } | undefined)
    ?.clustering;
  const granularity = prefs?.granularity;
  return {
    enabled: prefs?.enabled !== false,
    granularity:
      granularity === "fewer" || granularity === "more" ? granularity : "balanced",
  };
}

export async function liveClusters(
  ctx: ReadCtx,
  accountId: Id<"accounts">,
): Promise<Doc<"clusters">[]> {
  const rows = await ctx.db
    .query("clusters")
    .withIndex("by_account", (q) => q.eq("account_id", accountId))
    .collect();
  return rows.filter((c) => !c.deleted);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Hues spread around the wheel in golden-angle steps from a stable seed, so
 *  neighbours in creation order never share a colour. */
export function clusterHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return Math.round((h * 137.508) % 360);
}

export function normalizeClusterName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 48);
}

/** A live cluster of one kind whose name matches, case-insensitively. A
 *  theme and a stream may share a name: they are different things. */
export async function clusterNamed(
  ctx: ReadCtx,
  accountId: Id<"accounts">,
  name: string,
  kind: "theme" | undefined,
  except?: Id<"clusters">,
): Promise<Doc<"clusters"> | undefined> {
  return (await liveClusters(ctx, accountId)).find(
    (c) => c._id !== except && isTheme(c) === (kind === "theme") && c.name.toLowerCase() === name.toLowerCase(),
  );
}

/** Find a live cluster by name (case-insensitive) or create one. */
export async function ensureCluster(
  ctx: WriteCtx,
  accountId: Id<"accounts">,
  input: { name: string; description?: string; source: "user" | "ai"; kind?: "theme"; parent_id?: Id<"clusters"> },
  now: number,
): Promise<Doc<"clusters">> {
  const name = normalizeClusterName(input.name);
  if (!name) throw new Error("A cluster needs a name");
  const existing = await clusterNamed(ctx, accountId, name, input.kind);
  if (existing) {
    if (input.source === "ai" && !isMine(existing)) {
      const patch = { description: (input.description ?? existing.description).trim().slice(0, 240), updated_at: now };
      await ctx.db.patch(existing._id, patch);
      return { ...existing, ...patch };
    }
    return existing;
  }
  const id = await ctx.db.insert("clusters", {
    account_id: accountId,
    name,
    description: (input.description ?? "").trim().slice(0, 240),
    hue: clusterHue(name),
    kind: input.kind,
    parent_id: input.parent_id,
    source: input.source,
    created_at: now,
    updated_at: now,
  });
  return (await ctx.db.get(id))!;
}

/** Put threads in a cluster (or take them out with null). `source` says who
 *  decided; a "user" placement is never moved by the model. */
export async function placeThreads(
  ctx: WriteCtx & { scheduler?: MutationCtx["scheduler"] },
  accountId: Id<"accounts">,
  threadGmailIds: string[],
  clusterId: Id<"clusters"> | null,
  source: "user" | "ai",
  now: number,
): Promise<number> {
  let cluster: Doc<"clusters"> | null = null;
  if (clusterId) {
    cluster = await ctx.db.get(clusterId);
    if (!cluster || cluster.deleted || cluster.account_id !== accountId) throw new Error("No such topic");
    if (source === "user") await ctx.db.patch(clusterId, { source: "user", updated_at: now });
  }
  // A muted topic archives new mail: a thread Whisk first saw after the
  // switch was turned on leaves the inbox as it lands here, or in a stream
  // of a muted theme. Mail already in the inbox is left where it is.
  const parent = cluster?.parent_id ? await ctx.db.get(cluster.parent_id) : null;
  const archiveSince = cluster?.archive_new_since ?? (parent && !parent.deleted ? parent.archive_new_since : undefined);
  const account = archiveSince !== undefined && ctx.scheduler ? await ctx.db.get(accountId) : null;
  let archived = 0;
  let moved = 0;
  for (const gmailId of threadGmailIds) {
    const t = await ctx.db
      .query("threads")
      .withIndex("by_account_gmail", (q) =>
        q.eq("account_id", accountId).eq("gmail_id", gmailId),
      )
      .unique();
    if (!t || t.deleted) continue;
    // The model never overrides a hand placement.
    if (source === "ai") {
      if (t.cluster_source === "user" || !inInbox(t)) continue;
      const current = t.cluster_id ? await ctx.db.get(t.cluster_id) : null;
      if (current && isMine(current)) continue;
    }
    const next = clusterId ?? undefined;
    if (t.cluster_id === next && t.cluster_source === source) continue;
    await ctx.db.patch(t._id, {
      cluster_id: next,
      cluster_source: source,
      updated_at: now,
    });
    moved++;
    if (account && archiveSince !== undefined && t._creationTime >= archiveSince && inInbox(t)) {
      if (await modifyThreadLabels(ctx as OutboundCtx, account, gmailId, [], [SYSTEM_LABEL_IDS.INBOX])) archived++;
    }
  }
  if (archived > 0 && account) await schedulePump(ctx as OutboundCtx, account);
  return moved;
}

/** Threads currently in a cluster (inbox or not). */
export async function threadsInCluster(
  ctx: ReadCtx,
  accountId: Id<"accounts">,
  clusterId: Id<"clusters">,
): Promise<Doc<"threads">[]> {
  return await ctx.db
    .query("threads")
    .withIndex("by_account_cluster", (q) =>
      q.eq("account_id", accountId).eq("cluster_id", clusterId),
    )
    .collect();
}

/** The live streams inside a theme. */
export async function streamsInTheme(
  ctx: ReadCtx,
  accountId: Id<"accounts">,
  themeId: Id<"clusters">,
): Promise<Doc<"clusters">[]> {
  return (await liveClusters(ctx, accountId)).filter((c) => c.parent_id === themeId);
}

/** Tombstone a cluster and free its threads; a theme's streams stand on
 *  their own again. `judged` marks the freed threads as the person's word,
 *  so an incremental pass does not rebuild what they just took apart. */
export async function dissolveClusterRows(
  ctx: WriteCtx,
  cluster: Doc<"clusters">,
  now: number,
  opts: { judged: boolean },
): Promise<number> {
  const rows = await threadsInCluster(ctx, cluster.account_id, cluster._id);
  for (const t of rows) {
    await ctx.db.patch(t._id, {
      cluster_id: undefined,
      cluster_source: opts.judged ? "user" : undefined,
      updated_at: now,
    });
  }
  for (const s of await streamsInTheme(ctx, cluster.account_id, cluster._id)) {
    await ctx.db.patch(s._id, { parent_id: undefined, updated_at: now });
  }
  await ctx.db.patch(cluster._id, { deleted: true, updated_at: now });
  return rows.length;
}

/** Drop the model's empty topics: a stream with no inbox thread, then a
 *  theme with no live stream and no inbox thread of its own. The person's
 *  own topics stay, empty or not. Archived members keep their cluster_id
 *  and rejoin if they come back. */
export async function dissolveEmpty(ctx: WriteCtx, accountId: Id<"accounts">, now: number): Promise<number> {
  let dissolved = 0;
  const live = await liveClusters(ctx, accountId);
  const hasInboxMail = async (c: Doc<"clusters">) => (await threadsInCluster(ctx, accountId, c._id)).some(inInbox);
  const gone = new Set<string>();
  for (const c of live) {
    if (isTheme(c) || isMine(c) || (await hasInboxMail(c))) continue;
    await ctx.db.patch(c._id, { deleted: true, updated_at: now });
    gone.add(c._id);
    dissolved++;
  }
  for (const c of live) {
    if (!isTheme(c) || isMine(c)) continue;
    const children = live.some((s) => s.parent_id === c._id && !gone.has(s._id));
    if (children || (await hasInboxMail(c))) continue;
    await ctx.db.patch(c._id, { deleted: true, updated_at: now });
    dissolved++;
  }
  return dissolved;
}

/**
 * Land one model pass: new clusters first (keyed by the placeholder the
 * model used), then every assignment. Threads the model left out of every
 * cluster are marked judged (cluster_source "ai", no cluster), so they are
 * not re-asked until a revisit window brings them back.
 */
export const progressValidator = v.object({ done: v.number(), total: v.number(), review: v.boolean(), tidy: v.optional(v.boolean()) });

/** Note how far the running pass has read, for the sweep's progress line. */
export const noteProgress = internalMutation({
  args: { accountId: v.id("accounts"), startedAt: v.number(), progress: progressValidator },
  handler: async (ctx, { accountId, startedAt, progress }) => {
    const account = await ctx.db.get(accountId);
    if (!account || account.cluster_started_at !== startedAt) return;
    await ctx.db.patch(accountId, { cluster_progress: progress, updated_at: Date.now() });
  },
});

export const applyPass = internalMutation({
  args: {
    accountId: v.id("accounts"),
    startedAt: v.number(),
    progress: v.optional(progressValidator),
    newClusters: v.array(
      v.object({ key: v.string(), name: v.string(), description: v.string() }),
    ),
    assignments: v.array(
      v.object({
        thread_gmail_id: v.string(),
        // A cluster id, a placeholder key from newClusters, or null.
        target: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (ctx, { accountId, startedAt, progress, newClusters, assignments }) => {
    const account = await ctx.db.get(accountId);
    if (!account || account.cluster_started_at !== startedAt || !(await clusteringSettings(ctx, account)).enabled) return { created: 0, placed: 0, judged: 0, dissolved: 0 };
    const now = Date.now();
    if (progress) await ctx.db.patch(accountId, { cluster_progress: progress, updated_at: now });
    const live = await liveClusters(ctx, accountId);
    const byId = new Map<string, Doc<"clusters">>(live.map((c) => [c._id, c]));
    const byKey = new Map<string, Doc<"clusters">>();
    let created = 0;
    for (const nc of newClusters) {
      const name = normalizeClusterName(nc.name);
      if (!name) continue;
      const before = byId.size;
      const row = await ensureCluster(
        ctx,
        accountId,
        { name, description: nc.description, source: "ai" },
        now,
      );
      if (!byId.has(row._id)) {
        byId.set(row._id, row);
        if (byId.size > before) created++;
      }
      byKey.set(nc.key, row);
    }
    let placed = 0;
    let judged = 0;
    for (const a of assignments) {
      const target =
        a.target === null
          ? null
          : (byKey.get(a.target) ?? byId.get(a.target) ?? null);
      if (a.target !== null && !target) continue; // a name the model made up
      const n = await placeThreads(
        ctx,
        accountId,
        [a.thread_gmail_id],
        target ? target._id : null,
        "ai",
        now,
      );
      if (target) placed += n;
      else judged += n;
    }
    const dissolved = await dissolveEmpty(ctx, accountId, now);
    return { created, placed, judged, dissolved };
  },
});


// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/** How many loose senders the theme pass is shown: the biggest ones. */
const LOOSE_SENDERS_MAX = 120;

/** Everything the theme pass reads: the themes and streams that exist,
 *  what each stream holds and who sends it, and the inbox mail no stream
 *  claimed rolled up per sender (real correspondence left out: people are
 *  never a theme). */
export const themeRoster = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const live = await liveClusters(ctx, accountId);
    const themes: ThemeRow[] = live.filter(isTheme).map((c) => ({ _id: c._id as string, name: c.name, description: c.description, mine: isMine(c), size: 0 }));
    const topics: ThemeStream[] = live.filter((c) => !isTheme(c)).map((c) => ({
      _id: c._id as string, name: c.name, description: c.description, size: 0, mine: isMine(c),
      parent_id: c.parent_id && themes.some((t) => t._id === c.parent_id) ? (c.parent_id as string) : undefined,
      senders: [], lanes: [], samples: [],
    }));
    const themeById = new Map(themes.map((t) => [t._id, t]));
    const topicById = new Map(topics.map((t) => [t._id, t]));
    const senderTally = new Map<string, Map<string, number>>();
    const laneTally = new Map<string, Map<string, number>>();
    const loose = new Map<string, LooseSender>();
    const bump = (m: Map<string, Map<string, number>>, id: string, key: string) => {
      const inner = m.get(id) ?? new Map<string, number>();
      inner.set(key, (inner.get(key) ?? 0) + 1);
      m.set(id, inner);
    };
    let scanned = 0;
    for await (const t of ctx.db
      .query("threads")
      .withIndex("by_account_last", (q) => q.eq("account_id", accountId))
      .order("desc")) {
      if (++scanned > CANDIDATE_SCAN_CAP) break;
      if (!inInbox(t)) continue;
      const starter = t.participants[0];
      const domain = starter?.email.toLowerCase().split("@")[1] ?? "";
      const lane = t.category ?? "primary";
      if (t.cluster_id) {
        const theme = themeById.get(t.cluster_id);
        if (theme) { theme.size++; continue; }
        const topic = topicById.get(t.cluster_id);
        if (!topic) continue;
        topic.size++;
        if (topic.samples.length < 3) topic.samples.push(t.subject.slice(0, 80));
        if (domain) bump(senderTally, topic._id, domain);
        bump(laneTally, topic._id, lane);
        continue;
      }
      // Loose mail: judged and left out, or not yet seen. People are not
      // rolled up; a theme is for streams of automated mail.
      if (lane === "primary" || !domain || t.cluster_source === "user") continue;
      const row = loose.get(domain) ?? { key: domain, name: starter?.name ?? domain, size: 0, lane, samples: [] };
      row.size++;
      if (row.samples.length < 2) row.samples.push(t.subject.slice(0, 80));
      loose.set(domain, row);
    }
    for (const topic of topics) {
      const top = (m: Map<string, Map<string, number>>, n: number) => [...(m.get(topic._id) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
      topic.senders = top(senderTally, 3);
      topic.lanes = top(laneTally, 2);
      const parent = topic.parent_id ? themeById.get(topic.parent_id) : undefined;
      if (parent) parent.size += topic.size;
    }
    const senders = [...loose.values()].sort((a, b) => b.size - a.size).slice(0, LOOSE_SENDERS_MAX);
    const account = await ctx.db.get(accountId);
    const settings = await clusteringSettings(ctx, account);
    const memories = await ctx.db.query("memories").withIndex("by_account", (q) => q.eq("account_id", accountId)).collect();
    return { themes, topics, senders, preferences: memories.filter((m) => m.kind === "preference" && !m.deleted).map((m) => m.text), ...settings };
  },
});

/** Land a theme verdict: merges between streams first, then each theme is
 *  made or refreshed, its streams filed under it, and the loose senders
 *  it claimed placed in it directly. The person's own topics are never
 *  folded, renamed or moved; what they filed by hand stays filed. */
export const applyThemes = internalMutation({
  args: {
    accountId: v.id("accounts"),
    startedAt: v.number(),
    themes: v.array(v.object({ id: v.optional(v.string()), key: v.optional(v.string()), name: v.string(), description: v.string(), topics: v.array(v.string()), senders: v.array(v.string()) })),
    merges: v.array(v.object({ into: v.string(), from: v.array(v.string()), name: v.optional(v.string()) })),
  },
  handler: async (ctx, { accountId, startedAt, themes, merges }) => {
    const account = await ctx.db.get(accountId);
    if (!account || account.cluster_started_at !== startedAt || !(await clusteringSettings(ctx, account)).enabled) return { merged: 0, themed: 0, placed: 0 };
    const now = Date.now();
    const live = new Map((await liveClusters(ctx, accountId)).map((c) => [c._id as string, c]));
    let merged = 0;
    for (const m of merges) {
      const into = live.get(m.into);
      if (!into || isTheme(into)) continue;
      for (const id of m.from) {
        const from = live.get(id);
        if (!from || isMine(from) || isTheme(from)) continue;
        for (const t of await threadsInCluster(ctx, accountId, from._id)) {
          if (t.cluster_source === "user") continue;
          await ctx.db.patch(t._id, { cluster_id: into._id, cluster_source: "ai", updated_at: now });
        }
        await ctx.db.patch(from._id, { deleted: true, updated_at: now });
        live.delete(id);
        merged++;
      }
      // The merged stream takes the name the verdict gave it, unless the
      // person named it or another stream already has that name.
      if (m.name && !isMine(into)) {
        const name = normalizeClusterName(m.name);
        if (name && name !== into.name && !(await clusterNamed(ctx, accountId, name, undefined, into._id))) await ctx.db.patch(into._id, { name, updated_at: now });
      }
    }
    // Loose inbox mail by sender domain, read once for every theme below.
    const loose = new Map<string, string[]>();
    let scanned = 0;
    for await (const row of ctx.db.query("threads").withIndex("by_account_last", (q) => q.eq("account_id", accountId)).order("desc")) {
      if (++scanned > CANDIDATE_SCAN_CAP) break;
      if (row.cluster_id || row.cluster_source === "user" || !inInbox(row)) continue;
      const domain = row.participants[0]?.email.toLowerCase().split("@")[1];
      if (domain) loose.set(domain, [...(loose.get(domain) ?? []), row.gmail_id]);
    }
    // Which streams the verdict files, so the rest can be unfiled below.
    const filed = new Set<string>();
    let themed = 0;
    let placed = 0;
    for (const t of themes) {
      let theme = t.id ? live.get(t.id) : undefined;
      if (t.id && (!theme || !isTheme(theme))) continue;
      if (theme) {
        if (!isMine(theme) && (theme.name !== t.name || theme.description !== t.description)) {
          const clash = await clusterNamed(ctx, accountId, t.name, "theme", theme._id);
          await ctx.db.patch(theme._id, { name: clash ? theme.name : t.name, description: t.description, updated_at: now });
        }
      } else {
        theme = await ensureCluster(ctx, accountId, { name: t.name, description: t.description, source: "ai", kind: "theme" }, now);
        live.set(theme._id, theme);
      }
      themed++;
      for (const id of t.topics) {
        const stream = live.get(id);
        if (!stream || isTheme(stream) || stream._id === theme._id) continue;
        filed.add(id);
        // A stream the person filed by hand stays where they put it.
        if (isMine(stream) && stream.parent_id && live.get(stream.parent_id)) continue;
        if (stream.parent_id !== theme._id) await ctx.db.patch(stream._id, { parent_id: theme._id, updated_at: now });
      }
      const ids = t.senders.flatMap((key) => loose.get(key) ?? []);
      if (ids.length) placed += await placeThreads(ctx, accountId, ids, theme._id, "ai", now);
    }
    // A model stream the verdict left out of every theme stands on its own.
    for (const c of live.values()) {
      if (isTheme(c) || isMine(c) || filed.has(c._id) || !c.parent_id) continue;
      await ctx.db.patch(c._id, { parent_id: undefined, updated_at: now });
    }
    await dissolveEmpty(ctx, accountId, now);
    return { merged, themed, placed };
  },
});

/** Hand the run to the theme pass: same generation, a fresh action. */
export const startThemes = internalMutation({
  args: { accountId: v.id("accounts"), startedAt: v.number(), changed: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, { accountId, startedAt, changed, error }) => {
    const account = await ctx.db.get(accountId);
    if (!account || account.cluster_started_at !== startedAt) return;
    const job = await ctx.scheduler.runAfter(0, internal.ai.actions.themeInbox, { accountId, startedAt, changed, error });
    await ctx.db.patch(accountId, { cluster_job: job });
  },
});

export const continuePass = internalMutation({
  args: { accountId: v.id("accounts"), fresh: v.boolean(), startedAt: v.number(), pending: v.array(v.string()), remaining: v.array(v.string()), review: v.boolean(), done: v.number(), total: v.number(), created: v.number(), skipped: v.optional(v.number()), revisit: v.optional(v.boolean()) },
  handler: async (ctx, { accountId, fresh, ...continuation }) => {
    const account = await ctx.db.get(accountId);
    if (!account || account.cluster_started_at !== continuation.startedAt) return;
    if (!(await clusteringSettings(ctx, account)).enabled) {
      await ctx.db.patch(accountId, { cluster_job: undefined, cluster_started_at: undefined, cluster_dirty: undefined, cluster_progress: undefined, updated_at: Date.now() });
      return;
    }
    const job = await ctx.scheduler.runAfter(0, internal.ai.actions.clusterInbox, { accountId, fresh, continuation });
    await ctx.db.patch(accountId, { cluster_job: job });
  },
});

/** The topic tree of one mailbox as text, for reading a grouping run's
 *  result from the terminal: each theme, its streams and their sizes, then
 *  the streams in no theme and the mail in none. */
export const describeTree = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const account = (await ctx.db.query("accounts").collect()).find((a) => a.email === email);
    if (!account) return "no such account";
    const live = await liveClusters(ctx, account._id);
    const size = new Map<string, number>();
    const looseBySender = new Map<string, number>();
    let loose = 0, people = 0, scanned = 0;
    for await (const t of ctx.db.query("threads").withIndex("by_account_last", (q) => q.eq("account_id", account._id)).order("desc")) {
      if (++scanned > CANDIDATE_SCAN_CAP) break;
      if (!inInbox(t)) continue;
      if (t.cluster_id) { size.set(t.cluster_id, (size.get(t.cluster_id) ?? 0) + 1); continue; }
      if ((t.category ?? "primary") === "primary") { people++; continue; }
      loose++;
      const d = t.participants[0]?.email.split("@")[1] ?? "?";
      looseBySender.set(d, (looseBySender.get(d) ?? 0) + 1);
    }
    const lines: string[] = [];
    const themes = live.filter(isTheme);
    const streams = live.filter((c) => !isTheme(c));
    const total = (c: Doc<"clusters">) => (size.get(c._id) ?? 0) + streams.filter((s) => s.parent_id === c._id).reduce((n, s) => n + (size.get(s._id) ?? 0), 0);
    for (const t of themes.sort((a, b) => total(b) - total(a))) {
      lines.push(`# ${t.name} (${total(t)}${size.get(t._id) ? `, ${size.get(t._id)} direct` : ""})${isMine(t) ? " [mine]" : ""}${t.hidden ? " [muted]" : ""}\n  ${t.description}`);
      for (const s of streams.filter((s) => s.parent_id === t._id).sort((a, b) => (size.get(b._id) ?? 0) - (size.get(a._id) ?? 0))) lines.push(`  - ${s.name} (${size.get(s._id) ?? 0})${isMine(s) ? " [mine]" : ""}`);
    }
    const unthemed = streams.filter((s) => !s.parent_id || !themes.some((t) => t._id === s.parent_id));
    lines.push(`# (no theme) ${unthemed.length} streams`);
    for (const s of unthemed.sort((a, b) => (size.get(b._id) ?? 0) - (size.get(a._id) ?? 0))) lines.push(`  - ${s.name} (${size.get(s._id) ?? 0})`);
    lines.push(`# loose automated mail: ${loose} threads; people: ${people} threads`);
    for (const [d, n] of [...looseBySender.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) lines.push(`  - ${d} ${n}`);
    return lines.join("\n");
  },
});
