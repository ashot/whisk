/**
 * Structural shapes for the slice of a Convex context the engine touches.
 *
 * The engine ships outside every app repo, so it can never import a generated
 * `_generated/server`. It works against these structural types instead, and
 * each app passes its own real ctx in — the types line up by shape.
 */

export type EngineDb = {
  get: (id: any) => Promise<any>
  /** Present on a real Convex db; the engine falls back to a shape check. */
  normalizeId?: (table: any, id: string) => any
  query: (table: any) => any
  insert: (table: any, doc: any) => Promise<any>
  patch: (id: any, fields: any) => Promise<any>
}

export type EngineReadCtx = { db: Pick<EngineDb, 'get' | 'query'> }

export type EngineCtx = {
  db: EngineDb
  scheduler?: { runAfter: (delay: number, fn: any, args: any) => Promise<any> }
}

/**
 * How one table may be written from a client.
 *
 * `declared` is the security boundary: a field not listed is either folded
 * into the overflow bag or dropped. `immutable` wins over `declared` — a
 * client can never move an owner or an id, even by naming it.
 */
export type TableConfig = {
  kind: 'collection' | 'singleton'
  /** Column holding the row's owner, checked on every write. */
  ownerField: string
  /** Index used to find a singleton row for its owner. */
  lookupIndex?: string
  immutable: Set<string>
  declared: Set<string>
  /**
   * Open bag for undeclared fields. Without one, an undeclared field is
   * dropped; with one, it is deep merged so a new client preference never
   * needs a schema change.
   */
  overflowField?: string
  /**
   * Rewrite an incoming patch before it lands. Carried from codecast, where a
   * table uses it to adjust a client's fields against the stored row.
   *
   * Runs on collection writes only, after every filter: immutable and
   * declared checks, the ownership check, and the overflow merge. The hook
   * therefore sees exactly the fields about to be written. It receives the
   * stored row (`null` when the patch creates the row) and a copy of the
   * sanitized patch; whatever it returns is what lands. Return an empty
   * object to cancel the write.
   */
  beforePatch?: (doc: any, safe: Record<string, unknown>, actor?: unknown) => Record<string, unknown>
}

/** Rows created by a dispatch's patch pass, so side effects can find them. */
export type InsertedRows = Record<string, Array<{ id: string; client_id?: string }>>

/** One page of a delta read, plus the watermark the client may advance to. */
export type DeltaPage<Row = any> = {
  rows: Row[]
  nextSince: number
  hasMore: boolean
}
