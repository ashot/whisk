import { makeChangeTrackedDb, type ChangeTrackingOptions } from './changeLog'
import { makeSyncAckCollector, type SyncAckCollector, type SyncAckPosition } from './syncLog'

/**
 * The write interceptor.
 *
 * `createTrackedBuilders` returns drop in replacements for an app's generated
 * `mutation` and `internalMutation`. They behave identically EXCEPT that every
 * insert, patch, replace and delete to a tracked table also emits that entity's
 * change log row and sync log actions.
 *
 * Completeness comes from this ONE interception point: any mutation that
 * imports its builder from here emits automatically, no matter how it writes —
 * a direct ctx.db call, a helper, a data context, all bottom out at the wrapped
 * ctx.db. An app should pair that with a source level test that fails its build
 * when a file writing a tracked table imports the raw builders instead, so the
 * discipline is machine checked rather than remembered.
 *
 * No external dependency: the handler is wrapped here and ctx.db swapped for a
 * proxy. The interceptor's own change log writes go through the RAW db, so they
 * never re enter the proxy (no recursion; the log tables are untracked anyway).
 */

const SYNC_ACK = Symbol.for('platform.engine.syncAckCollector')

/** One layer of the write boundary: wrap a db, return the wrapped db. */
export type DbWrapper = (db: any, collector: SyncAckCollector) => any

export type TrackedBuilderOptions = {
  /** The app's generated `mutation` builder. */
  mutation: any
  /** The app's generated `internalMutation` builder. */
  internalMutation?: any
  /** What the change log tracks, and whether the sync log runs alongside it. */
  tracking?: ChangeTrackingOptions
  /**
   * Extra write boundaries, applied outward in order: the first wraps the
   * change tracked db, the next wraps that, and so on. An app puts a wrapper
   * that must observe the final domain transition last.
   */
  wrappers?: DbWrapper[]
}

/**
 * The sync log positions appended so far in this mutation's transaction. Empty
 * for a ctx that did not come through the wrapped builders (a raw test, say).
 */
export function syncAckPositions(ctx: any): SyncAckPosition[] {
  return ctx?.[SYNC_ACK]?.positions ?? []
}

/** Build the ctx a wrapped handler runs against: same ctx, tracked db. */
export function trackedCtx(ctx: any, options: TrackedBuilderOptions): any {
  const collector = makeSyncAckCollector()
  let db = ctx.db
  if (options.tracking) db = makeChangeTrackedDb(db, options.tracking, collector)
  for (const wrap of options.wrappers ?? []) db = wrap(db, collector)
  const wrapped = { ...ctx, db }
  wrapped[SYNC_ACK] = collector
  return wrapped
}

function wrapDefinition(def: any, options: TrackedBuilderOptions): any {
  if (typeof def === 'function') {
    return (ctx: any, args: any) => def(trackedCtx(ctx, options), args)
  }
  return { ...def, handler: (ctx: any, args: any) => def.handler(trackedCtx(ctx, options), args) }
}

/**
 * The app's builders, with the write boundary installed.
 *
 * The casts preserve the builder's own rich validator and typing surface; the
 * runtime wrapper only swaps ctx.db. Queries and actions are not wrapped —
 * neither has a ctx.db to intercept.
 */
export function createTrackedBuilders<
  Mutation = any,
  InternalMutation = any,
>(options: TrackedBuilderOptions): {
  mutation: Mutation
  internalMutation: InternalMutation
  syncAckPositions: (ctx: any) => SyncAckPosition[]
} {
  return {
    mutation: ((def: any) => options.mutation(wrapDefinition(def, options))) as Mutation,
    internalMutation: ((def: any) =>
      (options.internalMutation ?? options.mutation)(wrapDefinition(def, options))) as InternalMutation,
    syncAckPositions,
  }
}
