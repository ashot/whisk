import { describe, expect, test } from 'bun:test'
import {
  makeChangeTrackedDb,
  patchNeedsDocRead,
  scopeFromDoc,
  trackedTableOf,
} from './changeLog'
import { FakeDb } from './fakeDb'
import { TRACKED_TABLES, changeLogConfig } from './fixtures'

function makeFakeDb() {
  const db = new FakeDb({}, { tableIds: true })
  return { db: db as any, changeRows: () => db.tables.change_log ?? [] }
}

const tracked = (db: any) => makeChangeTrackedDb(db, { changeLog: changeLogConfig })

describe('scopeFromDoc', () => {
  test('extracts owner + team, stringified', () => {
    expect(scopeFromDoc({ user_id: 'users:1', team_id: 'teams:9' })).toEqual({
      owner_user_id: 'users:1',
      team_id: 'teams:9',
    })
  })
  test('team is undefined when absent', () => {
    expect(scopeFromDoc({ user_id: 'users:1' })).toEqual({
      owner_user_id: 'users:1',
      team_id: undefined,
    })
  })
  test('null doc yields no owner (delete of an already-gone row)', () => {
    expect(scopeFromDoc(null)).toEqual({ owner_user_id: undefined, team_id: undefined })
  })
  test('an app can name its own scope columns', () => {
    expect(scopeFromDoc({ account_id: 'a1', child_id: 'k1' }, { owner: 'account_id', team: 'child_id' }))
      .toEqual({ owner_user_id: 'a1', team_id: 'k1' })
  })
})

describe('patchNeedsDocRead', () => {
  test('needs a read when no prior row exists (first sight)', () => {
    expect(patchNeedsDocRead({ title: 'x' }, false)).toBe(true)
  })
  test('needs a read when the patch could move scope', () => {
    expect(patchNeedsDocRead({ team_id: 'teams:2' }, true)).toBe(true)
    expect(patchNeedsDocRead({ user_id: 'users:2' }, true)).toBe(true)
  })
  test('reuses the existing row scope for an ordinary field change (hot path)', () => {
    expect(patchNeedsDocRead({ inbox_dismissed_at: 123 }, true)).toBe(false)
    expect(patchNeedsDocRead({ message_count: 5 }, true)).toBe(false)
  })
  test('follows the app scope columns, not the default ones', () => {
    const fields = { owner: 'account_id', team: 'child_id' }
    expect(patchNeedsDocRead({ user_id: 'u2' }, true, fields)).toBe(false)
    expect(patchNeedsDocRead({ account_id: 'a2' }, true, fields)).toBe(true)
  })
})

describe('trackedTableOf', () => {
  const db = makeFakeDb().db
  test('identifies each tracked table from an id', () => {
    expect(trackedTableOf(db, 'conversations:1', TRACKED_TABLES)).toBe('conversations')
    expect(trackedTableOf(db, 'tasks:1', TRACKED_TABLES)).toBe('tasks')
    expect(trackedTableOf(db, 'docs:1', TRACKED_TABLES)).toBe('docs')
    expect(trackedTableOf(db, 'plans:1', TRACKED_TABLES)).toBe('plans')
    expect(trackedTableOf(db, 'projects:1', TRACKED_TABLES)).toBe('projects')
  })
  test('returns null for untracked ids', () => {
    expect(trackedTableOf(db, 'messages:1', TRACKED_TABLES)).toBeNull()
    expect(trackedTableOf(db, 'users:1', TRACKED_TABLES)).toBeNull()
  })
})

describe('makeChangeTrackedDb — emission', () => {
  test('insert into a tracked table emits one upsert row with scope', async () => {
    const { db, changeRows } = makeFakeDb()
    const tdb = tracked(db)
    const id = await tdb.insert('conversations', {
      user_id: 'users:1', team_id: 'teams:9', status: 'active',
    })
    const rows = changeRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      entity_type: 'conversations',
      entity_id: String(id),
      op: 'upsert',
      owner_user_id: 'users:1',
      team_id: 'teams:9',
    })
    expect(typeof rows[0]!.seq).toBe('number')
  })

  test('insert into an UNtracked table emits nothing', async () => {
    const { db, changeRows } = makeFakeDb()
    const tdb = tracked(db)
    await tdb.insert('messages', { user_id: 'users:1', content: 'hi' })
    expect(changeRows()).toHaveLength(0)
  })

  test('repeated writes to one entity upsert a SINGLE row (bounded by entity count)', async () => {
    const { db, changeRows } = makeFakeDb()
    const tdb = tracked(db)
    const id = await tdb.insert('tasks', { user_id: 'users:1', status: 'open' })
    await tdb.patch(id, { status: 'in_progress' })
    await tdb.patch(id, { status: 'done' })
    const rows = changeRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.op).toBe('upsert')
    expect(rows[0]!.entity_id).toBe(String(id))
  })

  test('a dismiss-style patch (no scope fields) still emits — the gap the feed closes', async () => {
    const { db, changeRows } = makeFakeDb()
    const tdb = tracked(db)
    const id = await tdb.insert('conversations', { user_id: 'users:1', status: 'active' })
    // The kind of write that does NOT bump updated_at, and so an updated_at
    // delta would miss.
    await tdb.patch(id, { inbox_dismissed_at: 123456 })
    const rows = changeRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ op: 'upsert', owner_user_id: 'users:1' })
  })

  test('delete emits an op:delete tombstone with the pre-delete scope', async () => {
    const { db, changeRows } = makeFakeDb()
    const tdb = tracked(db)
    const id = await tdb.insert('docs', { user_id: 'users:1', team_id: 'teams:3' })
    await tdb.delete(id)
    const rows = changeRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      entity_type: 'docs', op: 'delete', owner_user_id: 'users:1', team_id: 'teams:3',
    })
    expect(await db.get(id)).toBeNull()
  })

  test('a team reassignment patch refreshes the recorded team scope', async () => {
    const { db, changeRows } = makeFakeDb()
    const tdb = tracked(db)
    const id = await tdb.insert('tasks', { user_id: 'users:1', team_id: 'teams:1', status: 'open' })
    await tdb.patch(id, { team_id: 'teams:2' })
    const rows = changeRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.team_id).toBe('teams:2')
  })

  test('replace flips the existing row rather than adding one', async () => {
    const { db, changeRows } = makeFakeDb()
    const tdb = tracked(db)
    const id = await tdb.insert('plans', { user_id: 'users:1', title: 'one' })
    await tdb.replace(id, { user_id: 'users:2', title: 'two' })
    const rows = changeRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ entity_type: 'plans', owner_user_id: 'users:2' })
  })

  test('untracked patch/delete never touch the change log', async () => {
    const { db, changeRows } = makeFakeDb()
    const tdb = tracked(db)
    const id = await tdb.insert('messages', { user_id: 'users:1' })
    await tdb.patch(id, { content: 'x' })
    await tdb.delete(id)
    expect(changeRows()).toHaveLength(0)
  })

  test('a table the app leaves out of its catalog is untracked', async () => {
    const { db, changeRows } = makeFakeDb()
    const narrow = makeChangeTrackedDb(db, {
      changeLog: { trackedTables: new Set(['tasks']) },
    })
    await narrow.insert('docs', { user_id: 'users:1' })
    expect(changeRows()).toHaveLength(0)
    await narrow.insert('tasks', { user_id: 'users:1' })
    expect(changeRows()).toHaveLength(1)
  })

  test('a db without normalizeId is handed back untouched', () => {
    const mock = { insert: async () => 'x' }
    expect(makeChangeTrackedDb(mock, { changeLog: changeLogConfig })).toBe(mock)
  })
})
