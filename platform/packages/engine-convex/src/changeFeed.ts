import type { ChangeOp } from './changeLog'
import type { EngineReadCtx } from './types'

/**
 * Cross entity change feed — read side.
 *
 * `readChangesSince(since)` returns the SET of entity ids that changed in any
 * scope the caller can see (their own everything, plus the collaborative
 * entities shared to their teams) since the `seq` cursor. The client then batch
 * fetches the current state of those ids and applies upserts and prunes
 * deletes. An owner only entity type is NOT surfaced through a team scope: a
 * teammate seeing my session in the team feed is a separate axis with its own
 * cursor.
 *
 * The cursor is `seq` (the wall clock at write time), not a Convex pagination
 * cursor: each call is a fresh gt(since) range with a stable bound, so there is
 * no invalid cursor hazard, and the client advances `since` itself. Apply is
 * idempotent (upsert or prune by id), so the client re queries with a small
 * overlap and a rare commit reorder straggler or same millisecond page boundary
 * tie is harmless.
 */

export type FeedChange = {
  entity_type: string
  entity_id: string
  op: ChangeOp
}

export type ChangeRow = FeedChange & { seq: number }

export type ChangeFeedPage = {
  changes: FeedChange[]
  nextSince: number
  hasMore: boolean
}

/**
 * Pure merge of the per scope result pages into one gap free page. Each source
 * was fetched ascending by seq with take(limit+1); `capped` means it returned
 * the full limit+1 (more may exist beyond what we read).
 *
 * Gap free rule: when any source is capped we can only safely advance to the
 * LOWEST capped source's highest fetched seq — beyond that point some capped
 * source has unread rows. We emit only rows at or below that watermark; the
 * next call resumes from it. With no capped source, everything fetched is
 * emitted and the crawl is done. Unit tested.
 */
export function mergeChangeFeed(
  sources: Array<{ rows: ChangeRow[]; capped: boolean }>,
  since: number,
): ChangeFeedPage {
  const cappedMaxSeqs = sources
    .filter((s) => s.capped && s.rows.length > 0)
    .map((s) => s.rows[s.rows.length - 1]!.seq)
  const all = sources.flatMap((s) => s.rows)

  let within = all
  let hasMore = false
  let watermark: number | null = null
  if (cappedMaxSeqs.length > 0) {
    watermark = Math.min(...cappedMaxSeqs)
    within = all.filter((r) => r.seq <= watermark!)
    hasMore = true
  }

  // Dedup by entity id (an entity owned by the user AND shared to their team
  // appears in two scopes; one row per entity is enough — current state is
  // fetched either way). Keep the highest seq seen for that entity.
  const byEntity = new Map<string, ChangeRow>()
  for (const r of within) {
    const prev = byEntity.get(r.entity_id)
    if (!prev || r.seq > prev.seq) byEntity.set(r.entity_id, r)
  }
  const deduped = [...byEntity.values()].sort((a, b) => a.seq - b.seq)

  const nextSince = hasMore
    ? watermark!
    : deduped.length > 0
      ? deduped[deduped.length - 1]!.seq
      : since

  return {
    changes: deduped.map((r) => ({ entity_type: r.entity_type, entity_id: r.entity_id, op: r.op })),
    nextSince,
    hasMore,
  }
}

/** Where the feed reads from, and which entity types a team scope must not carry. */
export type ChangeFeedConfig = {
  /** Table holding one row per entity. */
  table?: string
  /** Index over (owner, seq). */
  ownerSeqIndex?: string
  /** Index over (team, seq). */
  teamSeqIndex?: string
  ownerField?: string
  teamField?: string
  /** Entity types a team scope never surfaces. */
  ownerOnlyEntities?: ReadonlySet<string>
  defaultLimit?: number
  maxLimit?: number
}

const DEFAULTS = {
  table: 'change_log',
  ownerSeqIndex: 'by_owner_seq',
  teamSeqIndex: 'by_team_seq',
  ownerField: 'owner_user_id',
  teamField: 'team_id',
  defaultLimit: 1000,
  maxLimit: 2000,
}

/**
 * One gap free page of the caller's changes. The owner scope carries every
 * tracked entity type; each team scope carries the collaborative ones.
 */
export async function readChangesSince(
  ctx: EngineReadCtx,
  args: { userId: unknown; teamIds: unknown[]; since: number; limit?: number },
  config: ChangeFeedConfig = {},
): Promise<ChangeFeedPage> {
  const table = config.table ?? DEFAULTS.table
  const ownerIndex = config.ownerSeqIndex ?? DEFAULTS.ownerSeqIndex
  const teamIndex = config.teamSeqIndex ?? DEFAULTS.teamSeqIndex
  const ownerField = config.ownerField ?? DEFAULTS.ownerField
  const teamField = config.teamField ?? DEFAULTS.teamField
  const ownerOnly = config.ownerOnlyEntities ?? new Set<string>()

  const limit = Math.min(
    args.limit ?? config.defaultLimit ?? DEFAULTS.defaultLimit,
    config.maxLimit ?? DEFAULTS.maxLimit,
  )
  const cap = limit + 1

  // Owner scope: everything the user owns, every tracked entity type.
  const ownerRows = (await ctx.db
    .query(table as any)
    .withIndex(ownerIndex as any, (q: any) => q.eq(ownerField, args.userId).gt('seq', args.since))
    .order('asc')
    .take(cap)) as ChangeRow[]

  const sources: Array<{ rows: ChangeRow[]; capped: boolean }> = [
    { rows: ownerRows, capped: ownerRows.length >= cap },
  ]

  // Team scopes: collaborative entities shared to a team the user belongs to.
  // Owner only types are excluded, so a team scoped event for one of them must
  // not pull a foreign row into this user's view.
  for (const teamId of args.teamIds) {
    const rows = (await ctx.db
      .query(table as any)
      .withIndex(teamIndex as any, (q: any) => q.eq(teamField, teamId).gt('seq', args.since))
      .order('asc')
      .take(cap)) as ChangeRow[]
    const collab = rows.filter((r) => !ownerOnly.has(r.entity_type))
    // `capped` is judged on the raw fetch (before the owner only filter): a full
    // page means more rows exist past the window regardless of how many
    // survived the filter.
    sources.push({ rows: collab, capped: rows.length >= cap })
  }

  return mergeChangeFeed(sources, args.since)
}

export type ChangesSinceOptions = {
  /** The app's `convex/values` validator namespace. */
  v: any
  /** Auth resolution, which stays in the app: the caller, or null when absent. */
  resolveUser: (ctx: any) => Promise<unknown | null>
  /** The caller's team scope keys. */
  teamIds: (ctx: any, userId: unknown) => Promise<unknown[]>
  config?: ChangeFeedConfig
}

/**
 * The feed as a plain Convex definition: `{ args, handler }`, ready for the
 * app's own `query` builder, the same shape `createDispatchDefinition` returns.
 */
export function createChangesSinceDefinition(options: ChangesSinceOptions) {
  const { v, resolveUser, teamIds, config } = options
  return {
    args: {
      since: v.number(),
      limit: v.optional(v.number()),
      // Ignored cache buster so the client's recovery probe can force a real
      // round trip past a stalled subscription.
      _probe: v.optional(v.number()),
    },
    handler: async (
      ctx: any,
      args: { since: number; limit?: number; _probe?: number },
    ): Promise<ChangeFeedPage> => {
      const userId = await resolveUser(ctx)
      if (!userId) return { changes: [], nextSince: args.since, hasMore: false }
      return readChangesSince(
        ctx,
        { userId, teamIds: await teamIds(ctx, userId), since: args.since, limit: args.limit },
        config,
      )
    },
  }
}
