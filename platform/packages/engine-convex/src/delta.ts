import type { DeltaPage, EngineReadCtx } from './types'

export const PAGE_LIMIT = 500

export type DeltaPageOptions<Row> = {
  table: string
  /** Index whose last column is the watermark field. */
  index: string
  /** Narrow the index to this caller's scope, above the `from` watermark. */
  range: (q: any, from: number) => any
  since?: number
  limit?: number
  /** Column the watermark reads. */
  watermarkField?: string
  /** Defense in depth after the index read; a false row never leaves here. */
  owned?: (row: any) => boolean
  /** Public projection applied to every row that ships. */
  project?: (row: any) => Row
}

/**
 * One page of rows changed after a watermark, including tombstones.
 *
 * ── Why this is not a naive cursor ──
 * `gt(updated_at).take(N)` silently drops rows: writes in one transaction
 * share a timestamp, and if the take boundary lands mid group the client
 * advances its watermark past rows it never saw. The rule here: never advance
 * past a timestamp we have not fully drained — trim the page back to the last
 * complete timestamp and report `hasMore` so the client comes straight back.
 */
export async function deltaPage<Row = any>(
  ctx: EngineReadCtx,
  options: DeltaPageOptions<Row>,
): Promise<DeltaPage<Row>> {
  const {
    table, index, range, since, owned,
    limit = PAGE_LIMIT,
    watermarkField = 'updated_at',
  } = options
  const project = options.project ?? ((row: any) => row as Row)
  const from = since ?? 0

  const raw: any[] = await ctx.db
    .query(table as any)
    .withIndex(index as any, (q: any) => range(q, from))
    .take(limit + 1)

  const rows = owned ? raw.filter(owned) : raw

  if (rows.length <= limit) {
    const next = rows.length ? Math.max(...rows.map((r) => r[watermarkField])) : from
    return { rows: rows.map(project), nextSince: next, hasMore: false }
  }

  const page = rows.slice(0, limit)
  const lastTs = page[page.length - 1]![watermarkField]
  let cut = page.length
  while (cut > 0 && page[cut - 1]![watermarkField] === lastTs) cut--

  if (cut === 0) {
    // One timestamp fills a whole page. The watermark has to advance past it
    // or the client never moves, so the only safe move is to ship the group
    // whole — which means re-reading it, because the page above was capped at
    // `limit + 1` and may hold only part of it.
    const group = await drainGroup(ctx, options, lastTs, limit)
    return { rows: group.map(project), nextSince: lastTs, hasMore: true }
  }

  const trimmed = page.slice(0, cut)
  return {
    rows: trimmed.map(project),
    nextSince: trimmed[trimmed.length - 1]![watermarkField],
    hasMore: true,
  }
}

/** Widest group a single read will assemble before it gives up and ships short. */
const GROUP_CEILING = 32_768

/**
 * Every row sharing one watermark value, read independently of the page above.
 *
 * Doubling rather than `collect()`: the range starts at one timestamp but has
 * no upper bound, so an unbounded read of a busy table would pull far more
 * than the group. Seeing any row past `ts` proves the group is complete,
 * because the index returns watermark ascending.
 */
async function drainGroup<Row>(
  ctx: EngineReadCtx,
  options: DeltaPageOptions<Row>,
  ts: number,
  limit: number,
): Promise<any[]> {
  const { table, index, range, owned, watermarkField = 'updated_at' } = options
  let size = limit * 2

  for (;;) {
    const raw: any[] = await ctx.db
      .query(table as any)
      .withIndex(index as any, (q: any) => range(q, ts - 1))
      .take(size + 1)

    const group = raw.filter((r) => r[watermarkField] === ts)
    const sawBeyond = raw.some((r) => r[watermarkField] > ts)

    if (sawBeyond || raw.length <= size || size >= GROUP_CEILING) {
      return owned ? group.filter(owned) : group
    }
    size *= 2
  }
}
