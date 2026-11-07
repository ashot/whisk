import { describe, expect, test } from 'bun:test'
import { fakeCtx } from './fakeDb'
import { deltaPage } from './delta'

/** `count` rows all sharing one updated_at. */
function group(ts: number, count: number, accountId = 'acct1') {
  return Array.from({ length: count }, (_, i) => ({
    _id: `${ts}_${i}`.padEnd(32, 'z'),
    account_id: accountId,
    child_id: 'kid1',
    updated_at: ts,
  }))
}

function read(ctx: any, since: number | undefined, limit: number) {
  return deltaPage(ctx, {
    table: 'blocks',
    index: 'by_child_updated',
    range: (q, from) => q.eq('child_id', 'kid1').gt('updated_at', from),
    since,
    limit,
    owned: (r) => r.account_id === 'acct1',
  })
}

describe('deltaPage', () => {
  test('a short page reports the max watermark and no more', async () => {
    const ctx = fakeCtx({ blocks: [...group(10, 2), ...group(20, 1)] })
    const page = await read(ctx, 0, 500)
    expect(page.rows).toHaveLength(3)
    expect(page.nextSince).toBe(20)
    expect(page.hasMore).toBe(false)
  })

  test('an empty read holds the watermark where it was', async () => {
    const ctx = fakeCtx({ blocks: group(10, 1) })
    const page = await read(ctx, 50, 500)
    expect(page.rows).toHaveLength(0)
    expect(page.nextSince).toBe(50)
    expect(page.hasMore).toBe(false)
  })

  test('never advances the watermark past a timestamp it did not drain', async () => {
    // Limit 3, and timestamp 20 straddles the boundary: 2 of its 3 rows would
    // fall inside the page. The page must stop at 10 instead.
    const ctx = fakeCtx({ blocks: [...group(10, 2), ...group(20, 3)] })
    const page = await read(ctx, 0, 3)
    expect(page.hasMore).toBe(true)
    expect(page.nextSince).toBe(10)
    expect(page.rows).toHaveLength(2)
    expect(page.rows.every((r: any) => r.updated_at === 10)).toBe(true)

    // The client comes back with 10 and drains the rest without loss.
    const next = await read(ctx, page.nextSince, 3)
    expect(next.rows).toHaveLength(3)
    expect(next.nextSince).toBe(20)
    expect(next.hasMore).toBe(false)
  })

  test('a timestamp group larger than a page ships whole', async () => {
    const ctx = fakeCtx({ blocks: group(10, 5) })
    const page = await read(ctx, 0, 3)
    expect(page.rows).toHaveLength(5)
    expect(page.nextSince).toBe(10)
    expect(page.hasMore).toBe(true)
  })

  test('a group many times a page wide still ships whole, losing nothing', async () => {
    // 40 rows share one millisecond against a page of 3, so the drain has to
    // double several times. Losing any of them would advance the watermark
    // past rows the client never saw.
    const ctx = fakeCtx({ blocks: [...group(10, 40), ...group(20, 1)] })
    const page = await read(ctx, 0, 3)
    expect(page.rows).toHaveLength(40)
    expect(page.nextSince).toBe(10)
    expect(page.hasMore).toBe(true)

    const next = await read(ctx, page.nextSince, 3)
    expect(next.rows).toHaveLength(1)
    expect(next.nextSince).toBe(20)
  })

  test('an oversized group excludes rows owned by another account', async () => {
    const ctx = fakeCtx({ blocks: [...group(10, 8), ...group(10, 8, 'intruder')] })
    const page = await read(ctx, 0, 3)
    expect(page.rows).toHaveLength(8)
    expect(page.rows.every((r: any) => r.account_id === 'acct1')).toBe(true)
  })

  test('a full page landing on a clean boundary keeps every row', async () => {
    const ctx = fakeCtx({ blocks: [...group(10, 3), ...group(20, 2)] })
    const page = await read(ctx, 0, 3)
    expect(page.rows).toHaveLength(3)
    expect(page.nextSince).toBe(10)
    expect(page.hasMore).toBe(true)
  })

  test('tombstones ride the same channel', async () => {
    const ctx = fakeCtx({
      blocks: [{ _id: 'd'.repeat(32), account_id: 'acct1', child_id: 'kid1', updated_at: 30, deleted: true }],
    })
    const page = await read(ctx, 0, 500)
    expect(page.rows).toHaveLength(1)
    expect((page.rows[0] as any).deleted).toBe(true)
  })

  test('rows from another account never leave, even on a shared index', async () => {
    const ctx = fakeCtx({ blocks: [...group(10, 1), ...group(20, 1, 'intruder')] })
    const page = await read(ctx, 0, 500)
    expect(page.rows).toHaveLength(1)
    expect((page.rows[0] as any).account_id).toBe('acct1')
  })

  test('the projection is applied to every row that ships', async () => {
    const ctx = fakeCtx({ blocks: group(10, 2) })
    const page = await deltaPage(ctx, {
      table: 'blocks',
      index: 'by_child_updated',
      range: (q, from) => q.eq('child_id', 'kid1').gt('updated_at', from),
      since: 0,
      project: ({ account_id, ...rest }: any) => rest,
    })
    expect(page.rows.every((r: any) => r.account_id === undefined)).toBe(true)
  })

  test('an absent since starts from zero', async () => {
    const ctx = fakeCtx({ blocks: group(10, 1) })
    const page = await read(ctx, undefined, 500)
    expect(page.rows).toHaveLength(1)
  })
})
