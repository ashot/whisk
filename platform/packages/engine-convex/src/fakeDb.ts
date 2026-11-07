/**
 * In-memory stand-in for the slice of a Convex db the engine uses.
 *
 * Only what the engine calls is modelled: an index read narrowed by `eq` and
 * `gt`, then `take`, `first`, `unique` or `collect`. Rows come back in
 * watermark order, which is what the real index guarantees for the delta rail.
 *
 * `tableIds` switches ids to `<table>:<n>` and turns on `normalizeId`, the
 * table from id primitive the write interceptor needs. It is off by default so
 * the rail's own tests keep seeing Convex shaped ids.
 */

type Row = Record<string, any>

export type FakeDbOptions = {
  /** Mint ids as `<table>:<n>` and answer `normalizeId` by prefix. */
  tableIds?: boolean
}

export class FakeDb {
  tables: Record<string, Row[]> = {}
  private seq = 0
  private tableIds: boolean

  constructor(seed: Record<string, Row[]> = {}, options: FakeDbOptions = {}) {
    this.tableIds = options.tableIds ?? false
    if (this.tableIds) {
      this.normalizeId = (table: string, id: any) =>
        String(id).split(':')[0] === table ? id : null
    }
    for (const [table, rows] of Object.entries(seed)) {
      this.tables[table] = rows.map((r) => ({ _id: r._id ?? this.nextId(table), ...r }))
    }
  }

  private nextId(table: string): string {
    this.seq += 1
    return this.tableIds ? `${table}:${this.seq}` : String(this.seq).padStart(32, 'a')
  }

  /** Present only with `tableIds`; a pure prefix check, never a document read. */
  normalizeId?: (table: string, id: any) => any

  async get(id: string): Promise<any> {
    for (const rows of Object.values(this.tables)) {
      const hit = rows.find((r) => r._id === id)
      if (hit) return hit
    }
    return null
  }

  async insert(table: string, doc: Row) {
    const _id = this.nextId(table)
    ;(this.tables[table] ??= []).push({ _id, ...doc })
    return _id
  }

  /**
   * Convex documents are immutable snapshots: a patch produces a new document
   * and leaves any reference read before it alone. The interceptor depends on
   * that — it reads a row before a scope moving write to learn the scope it is
   * leaving — so the row object is replaced here, never mutated in place.
   */
  async patch(id: string, fields: Row): Promise<any> {
    for (const rows of Object.values(this.tables)) {
      const at = rows.findIndex((r) => r._id === id)
      if (at < 0) continue
      const next = { ...rows[at] }
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      rows[at] = next
      return next
    }
    throw new Error(`no row ${id}`)
  }

  async replace(id: string, doc: Row): Promise<any> {
    for (const rows of Object.values(this.tables)) {
      const at = rows.findIndex((r) => r._id === id)
      if (at >= 0) {
        rows[at] = { _id: id, ...doc }
        return rows[at]
      }
    }
    throw new Error(`no row ${id}`)
  }

  async delete(id: string): Promise<void> {
    for (const rows of Object.values(this.tables)) {
      const at = rows.findIndex((r) => r._id === id)
      if (at >= 0) {
        rows.splice(at, 1)
        return
      }
    }
  }

  query(table: string) {
    const rows = this.tables[table] ?? []
    return {
      withIndex(_index: string, range?: (q: any) => any) {
        const eqs: Array<[string, unknown]> = []
        let gt: [string, number] | null = null
        const builder = {
          eq(field: string, value: unknown) {
            eqs.push([field, value])
            return builder
          },
          gt(field: string, value: number) {
            gt = [field, value]
            return builder
          },
        }
        if (range) range(builder)

        let out = rows.filter((r) => eqs.every(([f, val]) => r[f] === val))
        if (gt) {
          const [field, value] = gt as [string, number]
          out = out.filter((r) => r[field] > value)
          out = [...out].sort((a, b) => a[field] - b[field])
        }
        const page = {
          // Ascending is already the shape above; descending reverses it, which
          // for an index read with no range is newest first.
          order: (direction: 'asc' | 'desc' = 'asc') => {
            if (direction === 'desc') out = [...out].reverse()
            return page
          },
          take: async (n: number) => out.slice(0, n),
          collect: async () => out,
          first: async () => out[0] ?? null,
          unique: async () => {
            if (out.length > 1) throw new Error('unique() matched multiple rows')
            return out[0] ?? null
          },
        }
        return page
      },
    }
  }
}

/** A ctx shaped like the engine expects, over a FakeDb. */
export function fakeCtx(seed: Record<string, Row[]> = {}, options: FakeDbOptions = {}) {
  const db = new FakeDb(seed, options)
  const scheduled: Array<{ delay: number; fn: any; args: any }> = []
  return {
    db: db as any,
    scheduler: {
      runAfter: async (delay: number, fn: any, args: any) => {
        scheduled.push({ delay, fn, args })
      },
    },
    raw: db,
    scheduled,
  }
}
