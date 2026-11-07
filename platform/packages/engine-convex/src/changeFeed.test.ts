import { describe, expect, test } from 'bun:test'
import { mergeChangeFeed, readChangesSince, type ChangeRow } from './changeFeed'
import { makeChangeTrackedDb } from './changeLog'
import { FakeDb } from './fakeDb'
import { changeLogConfig } from './fixtures'

const row = (
  entity_id: string,
  seq: number,
  op: 'upsert' | 'delete' = 'upsert',
  entity_type = 'tasks',
): ChangeRow => ({ entity_type, entity_id, op, seq })

describe('mergeChangeFeed', () => {
  test('no capped source emits everything, hasMore false, cursor = max seq', () => {
    const r = mergeChangeFeed(
      [
        { rows: [row('a', 10), row('b', 20)], capped: false },
        { rows: [row('c', 15)], capped: false },
      ],
      0,
    )
    expect(r.hasMore).toBe(false)
    expect(r.nextSince).toBe(20)
    expect(r.changes.map((c) => c.entity_id)).toEqual(['a', 'c', 'b']) // sorted by seq
  })

  test('empty leaves the cursor unchanged and is not done-with-more', () => {
    const r = mergeChangeFeed([{ rows: [], capped: false }], 99)
    expect(r).toEqual({ changes: [], nextSince: 99, hasMore: false })
  })

  test('dedups an entity present in two scopes, keeping the latest seq', () => {
    const r = mergeChangeFeed(
      [
        { rows: [row('a', 10)], capped: false },
        { rows: [row('a', 30)], capped: false },
      ],
      0,
    )
    expect(r.changes).toEqual([{ entity_type: 'tasks', entity_id: 'a', op: 'upsert' }])
    expect(r.nextSince).toBe(30)
  })

  test('capped source: advances only to the lowest capped watermark, no gaps', () => {
    // The owner scope is capped at seq 50 (more exist beyond), the team scope is
    // uncapped up to 80. We must NOT emit team rows past 50, or a resume from
    // above 50 would skip owner rows between 50 and that point.
    const r = mergeChangeFeed(
      [
        { rows: [row('a', 10), row('b', 50)], capped: true },
        { rows: [row('c', 20), row('d', 80)], capped: false },
      ],
      0,
    )
    expect(r.hasMore).toBe(true)
    expect(r.nextSince).toBe(50)
    expect(r.changes.map((c) => c.entity_id)).toEqual(['a', 'c', 'b']) // d(80) excluded
  })

  test('two capped sources: the watermark is the LOWER of the two', () => {
    const r = mergeChangeFeed(
      [
        { rows: [row('a', 10), row('b', 40)], capped: true },
        { rows: [row('c', 15), row('d', 70)], capped: true },
      ],
      0,
    )
    expect(r.hasMore).toBe(true)
    expect(r.nextSince).toBe(40)
    expect(r.changes.map((c) => c.entity_id)).toEqual(['a', 'c', 'b'])
  })

  test('delete op is preserved through the merge', () => {
    const r = mergeChangeFeed([{ rows: [row('a', 5, 'delete')], capped: false }], 0)
    expect(r.changes).toEqual([{ entity_type: 'tasks', entity_id: 'a', op: 'delete' }])
  })
})

// The read side over a fake db: the same rows the interceptor wrote, fetched
// back through the two scoped indexes.
function feedDb(rows: Array<Record<string, any>>) {
  return new FakeDb({ change_log: rows }) as any
}

const feedConfig = { ownerOnlyEntities: new Set(['conversations']) }

describe('readChangesSince', () => {
  test('owner scope carries every tracked type; a team scope drops the owner-only one', async () => {
    const db = feedDb([
      { entity_type: 'conversations', entity_id: 'c1', op: 'upsert', owner_user_id: 'u1', team_id: 't1', seq: 10 },
      { entity_type: 'tasks', entity_id: 'k1', op: 'upsert', owner_user_id: 'u2', team_id: 't1', seq: 20 },
      { entity_type: 'conversations', entity_id: 'c2', op: 'upsert', owner_user_id: 'u2', team_id: 't1', seq: 30 },
    ])
    const page = await readChangesSince(
      { db }, { userId: 'u1', teamIds: ['t1'], since: 0 }, feedConfig,
    )
    // The user's own conversation, and the teammate's task. Never the
    // teammate's conversation.
    expect(page.changes.map((c) => c.entity_id).sort()).toEqual(['c1', 'k1'])
  })

  test('scope derivation routes an entity to the reader who owns it', async () => {
    const db = feedDb([
      { entity_type: 'tasks', entity_id: 'mine', op: 'upsert', owner_user_id: 'u1', seq: 10 },
      { entity_type: 'tasks', entity_id: 'theirs', op: 'upsert', owner_user_id: 'u2', seq: 11 },
    ])
    const mine = await readChangesSince({ db }, { userId: 'u1', teamIds: [], since: 0 }, feedConfig)
    const theirs = await readChangesSince({ db }, { userId: 'u2', teamIds: [], since: 0 }, feedConfig)
    expect(mine.changes.map((c) => c.entity_id)).toEqual(['mine'])
    expect(theirs.changes.map((c) => c.entity_id)).toEqual(['theirs'])
  })

  test('the watermark cannot skip a change: paging a capped owner scope loses nothing', async () => {
    const owned = Array.from({ length: 7 }, (_, i) => ({
      entity_type: 'tasks', entity_id: `k${i}`, op: 'upsert', owner_user_id: 'u1', seq: 10 + i,
    }))
    const teamed = Array.from({ length: 3 }, (_, i) => ({
      entity_type: 'docs', entity_id: `d${i}`, op: 'upsert', owner_user_id: 'u2', team_id: 't1', seq: 100 + i,
    }))
    const db = feedDb([...owned, ...teamed])

    const seen: string[] = []
    let since = 0
    for (let guard = 0; guard < 20; guard++) {
      const page = await readChangesSince(
        { db }, { userId: 'u1', teamIds: ['t1'], since, limit: 2 }, feedConfig,
      )
      seen.push(...page.changes.map((c) => c.entity_id))
      since = page.nextSince
      if (!page.hasMore) break
    }
    // Every change reached the client exactly once, in seq order.
    expect(seen).toEqual([...owned.map((r) => r.entity_id), ...teamed.map((r) => r.entity_id)])
  })

  test('a page never advances past a scope that still has unread rows', async () => {
    const db = feedDb([
      ...Array.from({ length: 5 }, (_, i) => ({
        entity_type: 'tasks', entity_id: `k${i}`, op: 'upsert', owner_user_id: 'u1', seq: 10 + i,
      })),
      { entity_type: 'docs', entity_id: 'far', op: 'upsert', owner_user_id: 'u2', team_id: 't1', seq: 900 },
    ])
    const page = await readChangesSince(
      { db }, { userId: 'u1', teamIds: ['t1'], since: 0, limit: 2 }, feedConfig,
    )
    expect(page.hasMore).toBe(true)
    // The owner scope filled its window and its last fetched row was seq 12, so
    // the cursor stops there and the far team row waits for a later page.
    expect(page.nextSince).toBe(12)
    expect(page.changes.map((c) => c.entity_id)).toEqual(['k0', 'k1', 'k2'])
  })

  test('the interceptor writes what the feed reads', async () => {
    const raw = new FakeDb({}, { tableIds: true }) as any
    const tdb = makeChangeTrackedDb(raw, { changeLog: changeLogConfig })
    const id = await tdb.insert('tasks', { user_id: 'u1', team_id: 't1', title: 'x' })
    const page = await readChangesSince(
      { db: raw }, { userId: 'u1', teamIds: ['t1'], since: 0 }, feedConfig,
    )
    expect(page.changes).toEqual([{ entity_type: 'tasks', entity_id: String(id), op: 'upsert' }])
  })
})
