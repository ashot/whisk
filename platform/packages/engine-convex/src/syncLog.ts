import type { ChangeScope } from './changeLog'

/**
 * Append only per scope sync action log — emission and read side.
 *
 * The write interceptor calls emitSyncActions / emitScopeAction on every
 * tracked write, in the SAME serializable transaction as the domain write.
 * Position allocation reads and bumps the scope's head row, so per scope
 * positions are strictly increasing in commit order — that is the whole
 * ordering proof. No wall clock is ever an ordering key (`ts` is retention and
 * debug metadata).
 *
 * Coalescing keeps the table bounded like the change log: an entity's active
 * upsert row is MOVED to the new head instead of appended again (patch
 * position, not insert), so a streaming conversation contributes one row per
 * scope, not one per counter bump. Moves preserve correctness: a reader either
 * sees the row at its old position (and the second stage fetches current state
 * anyway) or sees it again at the new one; applies are idempotent. Revocations
 * (a delete in a departed scope) always land as their own ordered action.
 */

export type SyncScopeKey = string // "user:<id>" | "team:<id>"
export type SyncOp = 'upsert' | 'delete' | 'scope_added' | 'scope_removed'
export type SyncAckPosition = { scope_key: SyncScopeKey; position: number }

/** Table, index and catalog names for one app's sync log. */
export type SyncLogConfig = {
  /** Table of ordered actions. */
  actionsTable?: string
  /** Table of one head row per scope. */
  headsTable?: string
  /** Index over a head's scope key. */
  scopeIndex?: string
  /** Index over (scope key, position) on the actions table. */
  scopePositionIndex?: string
  /** Index over (scope key, entity id) on the actions table. */
  scopeEntityIndex?: string
  /**
   * Fields a patch may touch without emitting an action, keyed by table. The
   * app's catalog: which of its columns are counters and liveness stamps.
   */
  churnOnlyFields?: Record<string, ReadonlySet<string>>
  /**
   * Entity types visible only to their owner, never to a team the row names.
   * Codecast lists conversations here: the inbox is mine, and a teammate
   * seeing my session in the team feed is a separate axis with its own cursor.
   */
  ownerOnlyEntities?: ReadonlySet<string>
  /** Stop emitting without a redeploy. Defaults to the SYNC_LOG_DISABLED env var. */
  disabled?: () => boolean
  now?: () => number
}

const DEFAULTS = {
  actionsTable: 'sync_actions',
  headsTable: 'sync_heads',
  scopeIndex: 'by_scope',
  scopePositionIndex: 'by_scope_position',
  scopeEntityIndex: 'by_scope_entity',
}

/**
 * Emergency kill switch, no redeploy needed. Emission is the only thing gated —
 * reads keep serving whatever exists, and the change log keeps its dual writes,
 * so flipping this parks the log without breaking either client generation.
 */
export function syncLogDisabled(): boolean {
  try {
    return process.env.SYNC_LOG_DISABLED === '1'
  } catch {
    return false
  }
}

/**
 * Per mutation collector: the positions this transaction appended (returned to
 * the client as its write acknowledgement when dispatch opts in), a dedupe set
 * so a mutation that writes the same entity repeatedly appends once per (scope,
 * entity, op) — safe because the transaction commits atomically — and a per
 * scope head cache so a bulk mutation reads each head row once instead of once
 * per row it touches. The collector is created per handler invocation, so an
 * optimistic concurrency retry starts clean and an acknowledgement can never
 * carry positions from an aborted attempt.
 */
export type SyncAckCollector = {
  positions: SyncAckPosition[]
  seen: Set<string>
  heads: Map<SyncScopeKey, { id: any; position: number }>
}

export function makeSyncAckCollector(): SyncAckCollector {
  return { positions: [], seen: new Set(), heads: new Map() }
}

/**
 * Whether a patch touches only fields the app declared as churn. Those are the
 * counter and liveness bumps a daemon writes on every message flush and
 * heartbeat; emitting them would put every streaming session's flush into
 * contention on the owner's single head row while buying an away client
 * nothing — the live snapshot floor re delivers these fields on reconnect.
 * Semantic fields (a title, a status, a dismiss stamp) are never listed.
 */
export function isChurnOnlyPatch(
  table: string,
  fields: Record<string, any>,
  churnOnlyFields: Record<string, ReadonlySet<string>> = {},
): boolean {
  const churn = churnOnlyFields[table]
  if (!churn) return false
  const keys = Object.keys(fields)
  return keys.length > 0 && keys.every((k) => churn.has(k))
}

export function userScopeKey(userId: string): SyncScopeKey {
  return `user:${userId}`
}
export function teamScopeKey(teamId: string): SyncScopeKey {
  return `team:${teamId}`
}

/**
 * The scopes an entity's actions land in. Mirrors change log semantics exactly:
 * the owner always, the team when the row names one, minus the entity types the
 * app marks owner only. Pure — unit tested.
 */
export function scopesForChange(
  entityType: string,
  scope: ChangeScope,
  ownerOnlyEntities: ReadonlySet<string> = new Set(),
): SyncScopeKey[] {
  if (!scope.owner_user_id) return []
  const scopes = [userScopeKey(scope.owner_user_id)]
  if (!ownerOnlyEntities.has(entityType) && scope.team_id) {
    scopes.push(teamScopeKey(scope.team_id))
  }
  return scopes
}

async function headFor(
  db: any,
  scopeKey: SyncScopeKey,
  config: SyncLogConfig,
): Promise<any | null> {
  return db
    .query(config.headsTable ?? DEFAULTS.headsTable)
    .withIndex(config.scopeIndex ?? DEFAULTS.scopeIndex, (q: any) => q.eq('scope_key', scopeKey))
    .unique()
}

/**
 * Allocate the next position for a scope (bumping or creating the head row).
 * The collector's head cache saves the INDEX LOOKUP on repeat allocations, but
 * the cached position is never trusted: a sub mutation runs in the same
 * transaction with its OWN collector, so the head row can be ahead of any one
 * collector's cache. Re reading by id (a transaction local read that sees all
 * in transaction writes, including sub mutation bumps) makes duplicate
 * positions impossible by construction — strictly increasing positions are the
 * whole ordering proof, so correctness must not depend on handler write order.
 */
async function allocatePosition(
  db: any,
  collector: SyncAckCollector | null,
  scopeKey: SyncScopeKey,
  ts: number,
  config: SyncLogConfig,
): Promise<number> {
  const cached = collector?.heads.get(scopeKey)
  if (cached) {
    const row = await db.get(cached.id)
    if (row) {
      const position = row.position + 1
      cached.position = position
      await db.patch(cached.id, { position, updated_at: ts })
      return position
    }
    collector?.heads.delete(scopeKey)
  }
  const head = await headFor(db, scopeKey, config)
  const position = (head?.position ?? 0) + 1
  let headId = head?._id
  if (head) {
    await db.patch(head._id, { position, updated_at: ts })
  } else {
    headId = await db.insert(config.headsTable ?? DEFAULTS.headsTable, {
      scope_key: scopeKey,
      position,
      floor: 0,
      updated_at: ts,
    })
  }
  collector?.heads.set(scopeKey, { id: headId, position })
  return position
}

/**
 * Append one action in one scope. For an upsert or delete of a tracked entity,
 * the entity's existing ACTIVE row in this scope (there is at most one, by this
 * very rule) is moved to the new position and flipped to the new op; scope
 * lifecycle actions always insert. `db` MUST be the raw (unwrapped) writer so
 * this never re enters the interceptor.
 */
export async function appendSyncAction(
  db: any,
  collector: SyncAckCollector | null,
  scopeKey: SyncScopeKey,
  entityType: string,
  entityId: string,
  op: SyncOp,
  config: SyncLogConfig = {},
): Promise<void> {
  if ((config.disabled ?? syncLogDisabled)()) return
  const dedupeKey = `${scopeKey} ${entityId} ${op}`
  if (collector) {
    if (collector.seen.has(dedupeKey)) return
    collector.seen.add(dedupeKey)
  }
  const actionsTable = config.actionsTable ?? DEFAULTS.actionsTable
  const ts = (config.now ?? Date.now)()
  const position = await allocatePosition(db, collector, scopeKey, ts, config)
  if (entityType !== 'scope') {
    const existing = await db
      .query(actionsTable)
      .withIndex(config.scopeEntityIndex ?? DEFAULTS.scopeEntityIndex, (q: any) =>
        q.eq('scope_key', scopeKey).eq('entity_id', entityId))
      .first()
    if (existing) {
      await db.patch(existing._id, { position, op, ts, entity_type: entityType })
      collector?.positions.push({ scope_key: scopeKey, position })
      return
    }
  }
  await db.insert(actionsTable, {
    scope_key: scopeKey,
    position,
    entity_type: entityType,
    entity_id: entityId,
    op,
    ts,
  })
  collector?.positions.push({ scope_key: scopeKey, position })
}

/**
 * Emit the sync log twin of a change log emission: one action per scope the
 * entity is visible in. `previousScope` (when the write moved the entity
 * between scopes) gets a revocation `delete` in each departed scope — the piece
 * the change log's mutable row loses.
 */
export async function emitSyncActions(
  db: any,
  collector: SyncAckCollector | null,
  entityType: string,
  entityId: string,
  op: 'upsert' | 'delete',
  scope: ChangeScope,
  previousScope: ChangeScope | null = null,
  config: SyncLogConfig = {},
): Promise<void> {
  const ownerOnly = config.ownerOnlyEntities
  const current = scopesForChange(entityType, scope, ownerOnly)
  if (previousScope) {
    const currentSet = new Set(current)
    for (const departed of scopesForChange(entityType, previousScope, ownerOnly)) {
      if (!currentSet.has(departed)) {
        await appendSyncAction(db, collector, departed, entityType, entityId, 'delete', config)
      }
    }
  }
  for (const scopeKey of current) {
    await appendSyncAction(db, collector, scopeKey, entityType, entityId, op, config)
  }
}

/**
 * Scope membership lifecycle: emitted in the affected USER's own scope when a
 * membership row is inserted or deleted, so the member's client learns to start
 * tracking (bootstrap) or purge (revoke) the team scope without a reload.
 */
export async function emitScopeAction(
  db: any,
  collector: SyncAckCollector | null,
  userId: string,
  teamId: string,
  op: 'scope_added' | 'scope_removed',
  config: SyncLogConfig = {},
): Promise<void> {
  await appendSyncAction(db, collector, userScopeKey(userId), 'scope', String(teamId), op, config)
}

// ── Read side ────────────────────────────────────────────────────────────────

const DEFAULT_RANGE_LIMIT = 500

export type SyncHead = { scope_key: SyncScopeKey; position: number; floor: number }

/**
 * The caller's scope heads. Tiny payload — this is the live subscription that
 * wakes the client applier; it re runs on tracked writes only, never on
 * heartbeats or messages.
 */
export async function readSyncHeads(
  db: any,
  scopeKeys: SyncScopeKey[],
  config: SyncLogConfig = {},
): Promise<{ heads: SyncHead[] }> {
  const heads: SyncHead[] = []
  for (const scopeKey of scopeKeys) {
    const head = await headFor(db, scopeKey, config)
    heads.push({
      scope_key: scopeKey,
      position: head?.position ?? 0,
      floor: head?.floor ?? 0,
    })
  }
  return { heads }
}

export type SyncRangePage = {
  actions: Array<{ position: number; entity_type: string; entity_id: string; op: SyncOp }>
  nextFrom: number
  hasMore: boolean
  resync?: boolean
}

/**
 * Ascending page of one scope's actions past `from`. `resync: true` means
 * retention has passed the caller's cursor — the client must backfill in full
 * and restamp. Kept separate from any auth check so the floor and paging
 * contract is unit testable against a fake db.
 */
export async function readRangePage(
  db: any,
  scopeKey: SyncScopeKey,
  from: number,
  limitArg?: number,
  config: SyncLogConfig = {},
): Promise<SyncRangePage> {
  const head = await headFor(db, scopeKey, config)
  if ((head?.floor ?? 0) > from) {
    return { actions: [], nextFrom: from, hasMore: false, resync: true }
  }
  const limit = Math.min(Math.max(limitArg ?? DEFAULT_RANGE_LIMIT, 1), 1000)
  const rows = await db
    .query(config.actionsTable ?? DEFAULTS.actionsTable)
    .withIndex(config.scopePositionIndex ?? DEFAULTS.scopePositionIndex, (q: any) =>
      q.eq('scope_key', scopeKey).gt('position', from))
    .order('asc')
    .take(limit + 1)
  const page = rows.slice(0, limit)
  const hasMore = rows.length > limit
  return {
    actions: page.map((r: any) => ({
      position: r.position,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      op: r.op,
    })),
    nextFrom: page.length > 0 ? page[page.length - 1].position : from,
    hasMore,
  }
}

export type SyncLogQueryOptions = {
  /** The app's `convex/values` validator namespace. */
  v: any
  /** Auth resolution, which stays in the app: the caller, or null when absent. */
  resolveUser: (ctx: any) => Promise<unknown | null>
  /** Every scope key the caller may read: their own, plus each team they belong to. */
  scopeKeys: (ctx: any, userId: unknown) => Promise<SyncScopeKey[]>
  config?: SyncLogConfig
}

/**
 * The two read endpoints as plain Convex definitions, ready for the app's own
 * `query` builder.
 *
 * A range read of a scope the caller does not hold is not an error (a client can
 * race a scope removal), but it must be DISTINGUISHABLE from an empty caught up
 * scope: the applier treats `authorized: false` as scope revocation, purging the
 * scope and dropping its cursor. That is the backstop for the case where the
 * scope removal action itself was already pruned by retention.
 */
export function createSyncLogDefinitions(options: SyncLogQueryOptions) {
  const { v, resolveUser, scopeKeys, config } = options
  return {
    heads: {
      args: {},
      handler: async (ctx: any) => {
        const userId = await resolveUser(ctx)
        if (!userId) return { heads: [] }
        return readSyncHeads(ctx.db, await scopeKeys(ctx, userId), config)
      },
    },

    range: {
      args: {
        scope_key: v.string(),
        from: v.number(),
        limit: v.optional(v.number()),
      },
      handler: async (
        ctx: any,
        args: { scope_key: string; from: number; limit?: number },
      ): Promise<SyncRangePage & { authorized?: boolean }> => {
        const userId = await resolveUser(ctx)
        if (!userId) return { actions: [], nextFrom: args.from, hasMore: false }
        const scopes = await scopeKeys(ctx, userId)
        if (!scopes.includes(args.scope_key)) {
          return { actions: [], nextFrom: args.from, hasMore: false, authorized: false }
        }
        return readRangePage(ctx.db, args.scope_key, args.from, args.limit, config)
      },
    },
  }
}

// ── Retention ────────────────────────────────────────────────────────────────

export const SYNC_ACTIONS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Given one scope's ascending action page, pick the deletable prefix. Pure —
 * unit tested. Returns the rows to delete and whether the walk stopped early
 * (it hit a young row, so the scope is fully drained for this window).
 */
export function prunablePrefix<T extends { ts: number }>(
  ascending: T[],
  cutoff: number,
): { toDelete: T[]; stoppedEarly: boolean } {
  const toDelete: T[] = []
  for (const row of ascending) {
    if (row.ts >= cutoff) return { toDelete, stoppedEarly: true }
    toDelete.push(row)
  }
  return { toDelete, stoppedEarly: false }
}

/**
 * One scope's prune step: a per scope PREFIX walk, never a global sweep. Read
 * ascending by position and delete the prefix of actions older than the
 * retention window, stopping at the first young action. The floor advances to
 * the last deleted position, and a walk that empties the scope sets the floor to
 * the head — so a client returning after the window always gets `resync: true`
 * instead of silently reading an empty range as caught up.
 *
 * This shape makes no monotonicity assumption about `ts` (retries can resample
 * it out of position order); `ts` stays retention metadata.
 *
 * `done` is false when the walk ran out of budget mid scope, so the app's
 * scheduled chain re enters this scope on its next run.
 */
export async function pruneScope(
  db: any,
  head: { _id: any; scope_key: string; position: number; floor?: number },
  cutoff: number,
  budget: number,
  config: SyncLogConfig = {},
  pageSize = 100,
): Promise<{ pruned: number; budget: number; done: boolean }> {
  const actionsTable = config.actionsTable ?? DEFAULTS.actionsTable
  const positionIndex = config.scopePositionIndex ?? DEFAULTS.scopePositionIndex
  let pruned = 0
  // Probe: the oldest retained action past the floor. Young (or absent with
  // nothing to advance) means this scope costs exactly one read.
  const oldest = await db
    .query(actionsTable)
    .withIndex(positionIndex, (q: any) =>
      q.eq('scope_key', head.scope_key).gt('position', head.floor ?? 0))
    .order('asc')
    .first()
  if (!oldest) {
    // Nothing above the floor: if the head advanced past the floor, every action
    // aged out earlier — set the floor to the head so a returning client
    // resyncs instead of mistaking emptiness for caught up.
    if ((head.floor ?? 0) < head.position) {
      await db.patch(head._id, { floor: head.position })
    }
    return { pruned, budget, done: true }
  }
  if (oldest.ts >= cutoff) return { pruned, budget, done: true } // fully drained for this window

  let from = head.floor ?? 0
  let newFloor = head.floor ?? 0
  let sawEnd = false
  let stoppedAtYoung = false
  while (budget > 0) {
    const pageLimit = Math.min(pageSize, budget)
    const page: { _id: any; ts: number; position: number }[] = await db
      .query(actionsTable)
      .withIndex(positionIndex, (q: any) =>
        q.eq('scope_key', head.scope_key).gt('position', from))
      .order('asc')
      .take(pageLimit)
    const { toDelete, stoppedEarly } = prunablePrefix(page, cutoff)
    for (const row of toDelete) {
      await db.delete(row._id)
      newFloor = row.position
      pruned++
      budget--
    }
    if (stoppedEarly) { stoppedAtYoung = true; break }
    if (page.length < pageLimit) { sawEnd = true; break }
    from = page[page.length - 1]!.position
  }
  // The scope drained: every remaining position up to the head is a hole (a
  // coalesced move left it), so the floor is the head — a cursor below it
  // missed a row that is now gone and must resync.
  if (sawEnd && newFloor < head.position) newFloor = head.position
  if (newFloor > (head.floor ?? 0)) {
    await db.patch(head._id, { floor: newFloor })
  }
  return { pruned, budget, done: sawEnd || stoppedAtYoung }
}
