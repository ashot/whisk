import type { SyncAckCollector, SyncLogConfig } from './syncLog'
import { emitScopeAction, emitSyncActions, isChurnOnlyPatch } from './syncLog'

/**
 * Cross entity change feed — emission side.
 *
 * The write interceptor calls into here on every insert / patch / replace /
 * delete to a tracked table. We keep ONE row per entity in the change log
 * (keyed by entity id) and bump its `seq` to now on each change, so the table
 * is bounded by entity count, not change volume — a conversation touched on
 * every message batch updates a single row in place.
 *
 * The pure helpers (scopeFromDoc / patchNeedsDocRead) are unit tested without
 * a db; the db touching emit/lookup are thin shells around them.
 *
 * The mechanism lives here; the catalog is the app's. `ChangeLogConfig` names
 * the tracked tables, the columns a scope is read off, and the table the rows
 * land in, so this file never sees an app schema.
 */

/** The owner and team a change belongs to. */
export type ChangeScope = {
  owner_user_id: string | undefined
  team_id: string | undefined
}

export type ChangeOp = 'upsert' | 'delete'

/** Document columns that carry a row's scope. */
export type ScopeFields = { owner: string; team: string }

export const DEFAULT_SCOPE_FIELDS: ScopeFields = { owner: 'user_id', team: 'team_id' }

/**
 * The app's catalog plus the names of the change log's own columns.
 *
 * A table is tracked iff its rows carry the uniform scope shape every catch up
 * query relies on. Keep `trackedTables` in sync with the entity type union in
 * the app's schema.
 */
export type ChangeLogConfig = {
  /** The tables whose writes feed the change log. */
  trackedTables: ReadonlySet<string>
  /** Table holding one row per entity. */
  table?: string
  /** Index over the entity id. */
  entityIndex?: string
  /** Column on a change row naming the owner. */
  ownerField?: string
  /** Column on a change row naming the team. */
  teamField?: string
  /** Columns on a tracked document that carry its scope. */
  scopeFields?: ScopeFields
  /** Read a scope off a document, when the columns alone are not enough. */
  scopeFromDoc?: (doc: any) => ChangeScope
  /** Name the entity type recorded on the row. Defaults to the table name. */
  entityType?: (table: string) => string
  /** The membership table whose writes announce a scope the user joined or left. */
  membership?: MembershipConfig
  now?: () => number
}

/** Where a scope membership row keeps the user and the team it joins. */
export type MembershipConfig = {
  table: string
  userField?: string
  teamField?: string
}

const DEFAULTS = {
  table: 'change_log',
  entityIndex: 'by_entity',
  ownerField: 'owner_user_id',
  teamField: 'team_id',
}

/**
 * The owner/team scope of an entity, read straight off its document. Every
 * tracked table uses these exact field names, so one extractor covers them all.
 * Pure — unit tested.
 */
export function scopeFromDoc(doc: any, fields: ScopeFields = DEFAULT_SCOPE_FIELDS): ChangeScope {
  return {
    owner_user_id: doc?.[fields.owner] ? String(doc[fields.owner]) : undefined,
    team_id: doc?.[fields.team] ? String(doc[fields.team]) : undefined,
  }
}

/**
 * Whether a patch needs a fresh document read to resolve scope, or can reuse
 * the scope already recorded on the entity's change log row. A read is needed
 * when the patch could MOVE the entity between scopes (touches a scope column)
 * or when there is no prior row to reuse. Pure — unit tested. Keeps the hot
 * path (a message batch bumping a conversation) to one indexed lookup, no
 * extra document get, in the common case where an ordinary field changed.
 */
export function patchNeedsDocRead(
  patchFields: Record<string, any>,
  hasExistingRow: boolean,
  fields: ScopeFields = DEFAULT_SCOPE_FIELDS,
): boolean {
  return !hasExistingRow || fields.owner in patchFields || fields.team in patchFields
}

/**
 * Identify which tracked table an id belongs to. `db.normalizeId(table, id)` is
 * a pure string check (no document read) that returns the id iff it belongs to
 * that table's id space, so this costs at most one cheap check per tracked
 * table and never a query. Returns null for untracked ids (the interceptor then
 * skips emission).
 */
export function trackedTableOf(db: any, id: any, trackedTables: ReadonlySet<string>): string | null {
  for (const table of trackedTables) {
    if (db.normalizeId(table, id)) return table
  }
  return null
}

/**
 * The single existing change log row for an entity (or null). first() not
 * unique(): a rare concurrent double insert leaves a duplicate that is harmless
 * (catch up dedups by entity id) rather than throwing on read.
 */
export async function lookupChangeRow(
  db: any,
  entityId: string,
  config: ChangeLogConfig,
): Promise<any | null> {
  return db
    .query(config.table ?? DEFAULTS.table)
    .withIndex(config.entityIndex ?? DEFAULTS.entityIndex, (q: any) => q.eq('entity_id', entityId))
    .first()
}

/**
 * Upsert the entity's change log row to { op, seq=now, scope }. `db` MUST be
 * the raw (unwrapped) writer so this never re enters the interceptor. Skips
 * silently if the scope has no owner — a tracked row always has an owner, so a
 * missing one means the document was already gone (a delete of an absent id).
 */
export async function emitChange(
  db: any,
  config: ChangeLogConfig,
  entityType: string,
  entityId: string,
  op: ChangeOp,
  scope: ChangeScope,
  existing?: any | null,
): Promise<void> {
  if (!scope.owner_user_id) return
  const table = config.table ?? DEFAULTS.table
  const ownerField = config.ownerField ?? DEFAULTS.ownerField
  const teamField = config.teamField ?? DEFAULTS.teamField
  const seq = (config.now ?? Date.now)()
  const row = existing !== undefined ? existing : await lookupChangeRow(db, entityId, config)
  const fields = {
    entity_type: entityType,
    entity_id: entityId,
    op,
    [ownerField]: scope.owner_user_id as any,
    [teamField]: scope.team_id as any,
    seq,
  }
  if (row) {
    await db.patch(row._id, {
      op,
      seq,
      [ownerField]: scope.owner_user_id as any,
      [teamField]: scope.team_id as any,
      entity_type: entityType,
    })
  } else {
    await db.insert(table, fields)
  }
}

/** Everything the interceptor needs to emit both logs for one app. */
export type ChangeTrackingOptions = {
  changeLog: ChangeLogConfig
  /** Also append the ordered per scope sync log. Omit to keep the change log alone. */
  syncLog?: SyncLogConfig
}

/**
 * Wrap a raw Convex DatabaseWriter so every insert/patch/replace/delete to a
 * tracked table also upserts the entity's change log row AND appends the
 * entity's sync log actions (syncLog.ts — the ordered per scope log that
 * supersedes this table's wall clock heuristic for new clients; both are
 * written until deployed client bundles roll off the change feed). Reads and id
 * helpers pass straight through. The interceptor's own change log and sync log
 * writes go through the RAW db handed in here, so they never re enter the
 * wrapper (no recursion; both tables are untracked regardless). The write
 * interceptor builds the custom mutation ctx from this; tests drive it with a
 * fake in memory db. Pure factory — it loads without the Convex runtime.
 *
 * `collector` (optional) accumulates the sync positions this transaction
 * appended; dispatch returns them to an opting in client as its write
 * acknowledgement.
 */
export function makeChangeTrackedDb(
  rawDb: any,
  options: ChangeTrackingOptions,
  collector: SyncAckCollector | null = null,
): any {
  // Only wrap a real Convex DatabaseWriter, detected via normalizeId — the
  // table from id primitive the interceptor relies on. A partial test mock that
  // lacks it is returned untouched, so the interceptor never changes a mock's
  // behaviour. In production ctx.db always has normalizeId, so this always wraps.
  if (typeof rawDb.normalizeId !== 'function') return rawDb

  const config = options.changeLog
  const sync = options.syncLog
  const tracked = config.trackedTables
  const scopeFields = config.scopeFields ?? DEFAULT_SCOPE_FIELDS
  const readScope = config.scopeFromDoc ?? ((doc: any) => scopeFromDoc(doc, scopeFields))
  const nameOf = (table: string) => (config.entityType ? config.entityType(table) : table)
  const membership = config.membership
  const memberUser = membership?.userField ?? scopeFields.owner
  const memberTeam = membership?.teamField ?? scopeFields.team

  const emitSync = async (
    entityType: string,
    entityId: string,
    op: ChangeOp,
    scope: ChangeScope,
    previousScope: ChangeScope | null = null,
  ) => {
    if (!sync) return
    await emitSyncActions(rawDb, collector, entityType, entityId, op, scope, previousScope, sync)
  }

  return {
    get: (...args: any[]) => rawDb.get(...args),
    query: (...args: any[]) => rawDb.query(...args),
    normalizeId: (...args: any[]) => rawDb.normalizeId(...args),
    system: rawDb.system,

    async insert(table: string, doc: any) {
      const id = await rawDb.insert(table, doc)
      if (tracked.has(table)) {
        const scope = readScope(doc)
        await emitChange(rawDb, config, nameOf(table), String(id), 'upsert', scope, null)
        await emitSync(nameOf(table), String(id), 'upsert', scope)
      } else if (
        sync && membership && table === membership.table &&
        doc?.[memberUser] && doc?.[memberTeam]
      ) {
        await emitScopeAction(
          rawDb, collector, String(doc[memberUser]), String(doc[memberTeam]), 'scope_added', sync,
        )
      }
      return id
    },

    async patch(id: any, fields: any) {
      const table = trackedTableOf(rawDb, id, tracked)
      // A patch that touches scope fields can MOVE the entity between scopes;
      // the departed scope needs a revocation action, which requires the pre
      // write doc.
      const movesScope = !!table && (scopeFields.owner in fields || scopeFields.team in fields)
      const preDoc = movesScope ? await rawDb.get(id) : null
      const res = await rawDb.patch(id, fields)
      if (table) {
        const entityId = String(id)
        const existing = await lookupChangeRow(rawDb, entityId, config)
        let scope: ChangeScope
        if (patchNeedsDocRead(fields, !!existing, scopeFields)) {
          const doc = await rawDb.get(id)
          scope = doc
            ? readScope(doc)
            : {
                owner_user_id: existing?.[config.ownerField ?? DEFAULTS.ownerField],
                team_id: existing?.[config.teamField ?? DEFAULTS.teamField],
              }
        } else {
          scope = {
            owner_user_id: existing[config.ownerField ?? DEFAULTS.ownerField],
            team_id: existing[config.teamField ?? DEFAULTS.teamField],
          }
        }
        await emitChange(rawDb, config, nameOf(table), entityId, 'upsert', scope, existing)
        // Churn exemption: counter and liveness only patches never touch the
        // sync log — emitting them would serialize every streaming session of a
        // user on one head row and wake every online client per message flush.
        // The live snapshot floor re delivers these fields on reconnect.
        if (!isChurnOnlyPatch(table, fields, sync?.churnOnlyFields)) {
          await emitSync(
            nameOf(table), entityId, 'upsert', scope,
            preDoc ? readScope(preDoc) : null,
          )
        }
      }
      return res
    },

    async replace(id: any, doc: any) {
      const table = trackedTableOf(rawDb, id, tracked)
      const preDoc = table ? await rawDb.get(id) : null
      const res = await rawDb.replace(id, doc)
      if (table) {
        // `undefined` (not null): a replaced entity usually already has a change
        // log row from its insert — look it up and flip it, do not add one.
        await emitChange(rawDb, config, nameOf(table), String(id), 'upsert', readScope(doc))
        await emitSync(
          nameOf(table), String(id), 'upsert', readScope(doc),
          preDoc ? readScope(preDoc) : null,
        )
      }
      return res
    },

    async delete(id: any) {
      const table = trackedTableOf(rawDb, id, tracked)
      const membershipDoc =
        !table && membership && rawDb.normalizeId(membership.table, id)
          ? await rawDb.get(id)
          : null
      // Read scope BEFORE the row is gone.
      const scope = table ? readScope(await rawDb.get(id)) : null
      const res = await rawDb.delete(id)
      if (table && scope) {
        // `undefined`: find the entity's existing upsert row and flip it to a
        // delete tombstone, rather than inserting a duplicate.
        await emitChange(rawDb, config, nameOf(table), String(id), 'delete', scope)
        await emitSync(nameOf(table), String(id), 'delete', scope)
      } else if (sync && membershipDoc?.[memberUser] && membershipDoc?.[memberTeam]) {
        await emitScopeAction(
          rawDb, collector,
          String(membershipDoc[memberUser]), String(membershipDoc[memberTeam]),
          'scope_removed', sync,
        )
      }
      return res
    },
  }
}
