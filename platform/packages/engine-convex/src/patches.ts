import type { EngineCtx, InsertedRows, TableConfig } from './types'

/** Fields no client may ever set, whatever the table. */
export const BASE_IMMUTABLE = ['_id', '_creationTime']

/** Convex document ids are 32 lowercase alphanumerics; client stubs are not. */
export function isConvexId(id: string): boolean {
  return /^[a-z0-9]{32}$/.test(id)
}

/** `undefined` on the wire arrives as null; treat it as a field clear. */
export function nullToUndefined(value: unknown) {
  return value === null ? undefined : value
}

/**
 * Merge an incoming open bag over the stored one, one level deep. A null or
 * undefined value deletes its key rather than storing an empty slot, so a
 * client can drop a preference it no longer sets.
 */
export function deepMergeBag(existing: unknown, incoming: unknown): unknown {
  if (
    incoming && typeof incoming === 'object' && !Array.isArray(incoming) &&
    existing && typeof existing === 'object' && !Array.isArray(existing)
  ) {
    const merged: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(existing)) {
      if (value !== null && value !== undefined) merged[key] = value
    }
    for (const [key, value] of Object.entries(incoming)) {
      if (value === null || value === undefined) delete merged[key]
      else merged[key] = value
    }
    return merged
  }
  return incoming
}

export type CollectionOptions = {
  /** Owner column written on insert and checked on update. */
  ownerField?: string
  /** Second scope column (aurora's `child_id`); required to insert a new row. */
  scopeField?: string
  overflowField?: string
  /** Extra fields beyond `updated_at`, `deleted`, `client_id`. */
  systemFields?: string[]
  /** Rewrite the sanitized patch before it lands; see `TableConfig`. */
  beforePatch?: TableConfig['beforePatch']
}

/**
 * A client-writable collection. `fields` is the writable surface; anything
 * else a client sends is dropped unless the table declares an overflow bag.
 */
export function collection(
  fields: string[],
  extraImmutable: string[] = [],
  options: CollectionOptions = {},
): TableConfig {
  const ownerField = options.ownerField ?? 'account_id'
  const systemFields = options.systemFields ?? ['updated_at', 'deleted', 'client_id']
  return {
    kind: 'collection',
    ownerField,
    immutable: new Set([
      ...BASE_IMMUTABLE,
      ownerField,
      ...(options.scopeField ? [options.scopeField] : []),
      ...extraImmutable,
    ]),
    declared: new Set([...fields, ...systemFields]),
    overflowField: options.overflowField,
    beforePatch: options.beforePatch,
  }
}

/** A single per-owner row, upserted rather than created by id. */
export function singleton(
  fields: string[],
  options: { ownerField: string; lookupIndex: string; overflowField?: string; extraImmutable?: string[] },
): TableConfig {
  return {
    kind: 'singleton',
    ownerField: options.ownerField,
    lookupIndex: options.lookupIndex,
    immutable: new Set([...BASE_IMMUTABLE, options.ownerField, ...(options.extraImmutable ?? [])]),
    declared: new Set([...fields, 'updated_at']),
    overflowField: options.overflowField,
  }
}

export type ApplyPatchesOptions = {
  /**
   * Second scope column carried onto inserted collection rows. A patch that
   * would create a row without it is skipped: the server will not invent a
   * scope for data it has never seen.
   */
  scopeField?: string
  /** Value for `scopeField` when the payload does not carry one. */
  scopeId?: unknown
  /** Clock seam, so tests can pin `updated_at`. */
  now?: () => number
  /** The resolved actor, handed to every `beforePatch` so a table can stamp who wrote. */
  actor?: unknown
  /**
   * Whether a scope value belongs to the owner. The insert path takes the
   * scope from the client payload, so without this a client could file rows
   * under another owner's child. Required whenever `scopeField` is set and
   * the payload may carry the scope; a create with a scope this rejects is
   * skipped.
   */
  scopeOwned?: (ctx: EngineCtx, scopeId: unknown, ownerId: unknown) => Promise<boolean>
}

/**
 * Apply a client's field patches to the tables it is allowed to own.
 *
 * `tables` is the allowlist and the whole security boundary: a table absent
 * from it cannot be written from a client at all, and within a listed table
 * only `declared` fields land. Everything else is either folded into the
 * overflow bag or dropped silently — a rejected field must never fail the
 * write, or one stale client would wedge the rail.
 */
export async function applyPatches(
  ctx: EngineCtx,
  tables: Record<string, TableConfig>,
  ownerId: unknown,
  patches: Record<string, Record<string, Record<string, unknown>>>,
  options: ApplyPatchesOptions = {},
): Promise<InsertedRows> {
  const now = options.now ?? Date.now
  const inserted: InsertedRows = {}

  for (const [table, docs] of Object.entries(patches)) {
    const config = tables[table]
    if (!config) continue

    for (const [rowId, fields] of Object.entries(docs)) {
      const safe: Record<string, unknown> = {}
      let overflow: Record<string, unknown> | null = null

      for (const [key, value] of Object.entries(fields)) {
        if (config.immutable.has(key)) continue
        if (config.declared.has(key)) {
          safe[key] = nullToUndefined(value)
        } else if (config.overflowField) {
          overflow ??= {}
          overflow[key] = value
        }
      }
      if (Object.keys(safe).length === 0 && !overflow) continue

      safe.updated_at = now()

      if (config.kind === 'singleton') {
        const existing: any = await ctx.db
          .query(table as any)
          .withIndex(config.lookupIndex as any, (q: any) => q.eq(config.ownerField, ownerId))
          .unique()

        if (overflow && config.overflowField) {
          safe[config.overflowField] = deepMergeBag(
            safe[config.overflowField] ?? existing?.[config.overflowField],
            overflow,
          )
        }

        if (existing) await ctx.db.patch(existing._id, safe as any)
        else await ctx.db.insert(table as any, { [config.ownerField]: ownerId, ...safe } as any)
        continue
      }

      // Collections: a patch for a row the server has never seen is an
      // optimistic create; the insert path carries the scope from the payload.
      const known = resolveRowId(ctx, table, rowId)
      const existing: any = known ? await ctx.db.get(known) : null

      if (existing) {
        if (existing[config.ownerField] !== ownerId) continue
        if (overflow && config.overflowField) {
          safe[config.overflowField] = deepMergeBag(
            safe[config.overflowField] ?? existing[config.overflowField],
            overflow,
          )
        }
        // Last transform before the write, as in the donor (codecast
        // dispatch.ts:340): the hook sees the fully sanitized patch on a copy,
        // and an empty return cancels the write.
        const finalSafe = config.beforePatch ? config.beforePatch(existing, { ...safe }, options.actor) : safe
        if (Object.keys(finalSafe).length === 0) continue
        await ctx.db.patch(existing._id, finalSafe as any)
        continue
      }

      if (overflow && config.overflowField) {
        safe[config.overflowField] = deepMergeBag(safe[config.overflowField], overflow)
      }
      // The donor rail never inserts, so the hook's create-side contract is
      // ours: same position (after every filter, before the write), with null
      // standing in for the row that does not exist yet. Owner and scope are
      // added after the hook from server-resolved values, so it cannot move
      // a row across owners.
      const finalSafe = config.beforePatch ? config.beforePatch(null, { ...safe }, options.actor) : safe
      if (Object.keys(finalSafe).length === 0) continue
      const row: Record<string, unknown> = { ...finalSafe, [config.ownerField]: ownerId }
      if (options.scopeField) {
        const scopeId = fields[options.scopeField] ?? options.scopeId
        if (!scopeId) continue
        if (options.scopeOwned && !(await options.scopeOwned(ctx, scopeId, ownerId))) continue
        row[options.scopeField] = scopeId
      }
      const newId = await ctx.db.insert(table as any, row as any)
      ;(inserted[table] ??= []).push({
        id: newId as string,
        client_id: finalSafe.client_id as string | undefined,
      })
    }
  }

  return inserted
}

/**
 * Decide whether a patch key names a row the server issued, or a client stub.
 *
 * `normalizeId` is the database's own answer and the one to trust: it knows
 * the id format and the table it belongs to. The regex is the fallback for a
 * db that does not expose it, and it is why passing a stub straight to `get`
 * is never safe — a malformed id throws rather than returning null.
 */
function resolveRowId(ctx: EngineCtx, table: string, rowId: string): any {
  const db = ctx.db as any
  if (typeof db.normalizeId === 'function') return db.normalizeId(table, rowId)
  return isConvexId(rowId) ? rowId : null
}

/**
 * The client middleware sends a store action's whole argument list, so
 * `archiveThreads({ops}, 'Archived')` arrives as `[{ops}, 'Archived']`. Only
 * the first argument is the server payload; the rest are client concerns like
 * an undo label and are ignored here.
 */
export function sideEffectPayload(actionArgs: unknown): any {
  const first = Array.isArray(actionArgs) ? actionArgs[0] : actionArgs
  return first && typeof first === 'object' ? first : {}
}
