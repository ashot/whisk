import { describe, expect, test } from 'bun:test'
import { FakeDb } from './fakeDb'
import {
  clearSyncCursors,
  createSyncCursorDefinitions,
  readSyncCursor,
  writeSyncCursor,
} from './syncCursors'

const db = () => new FakeDb({}) as any

describe('sync cursors', () => {
  test('a stream with no cursor reads as null', async () => {
    expect(await readSyncCursor(db(), 'u1', 'log-a')).toBeNull()
  })

  test('the first write creates the row, the next moves it', async () => {
    const d = db()
    await writeSyncCursor(d, 'u1', 'log-a', 100)
    await writeSyncCursor(d, 'u1', 'log-a', 250)
    expect(await readSyncCursor(d, 'u1', 'log-a')).toBe(250)
    expect(d.tables.sync_cursors).toHaveLength(1)
  })

  test('streams and owners keep separate positions', async () => {
    const d = db()
    await writeSyncCursor(d, 'u1', 'log-a', 10)
    await writeSyncCursor(d, 'u1', 'log-b', 20)
    await writeSyncCursor(d, 'u2', 'log-a', 30)
    expect(await readSyncCursor(d, 'u1', 'log-a')).toBe(10)
    expect(await readSyncCursor(d, 'u1', 'log-b')).toBe(20)
    expect(await readSyncCursor(d, 'u2', 'log-a')).toBe(30)
  })

  test('clearing drops one owner cursors and leaves the others', async () => {
    const d = db()
    await writeSyncCursor(d, 'u1', 'log-a', 10)
    await writeSyncCursor(d, 'u1', 'log-b', 20)
    await writeSyncCursor(d, 'u2', 'log-a', 30)
    expect(await clearSyncCursors(d, 'u1')).toEqual({ deleted: 2 })
    expect(await readSyncCursor(d, 'u1', 'log-a')).toBeNull()
    expect(await readSyncCursor(d, 'u2', 'log-a')).toBe(30)
  })

  test('an app can name its own columns', async () => {
    const d = db()
    const config = {
      table: 'cursors',
      ownerIndex: 'by_account',
      ownerField: 'account_id',
      keyField: 'source',
      positionField: 'offset',
      updatedField: 'synced_at',
    }
    await writeSyncCursor(d, 'a1', 'mailbox', 7, config)
    expect(d.tables.cursors[0]).toMatchObject({ account_id: 'a1', source: 'mailbox', offset: 7 })
    expect(await readSyncCursor(d, 'a1', 'mailbox', config)).toBe(7)
  })
})

const v = {
  string: () => 'string',
  number: () => 'number',
  optional: (inner: string) => `optional<${inner}>`,
}

describe('the cursor definitions', () => {
  const build = (resolved: unknown) =>
    createSyncCursorDefinitions({
      v,
      resolveOwner: { write: async () => resolved },
    })

  test('a caller may only move its own cursor', async () => {
    const ctx = { db: db() }
    const defs = build('u1')
    await defs.update.handler(ctx, { user_id: 'u1', file_path_hash: 'h', last_position: 5 })
    expect(await readSyncCursor(ctx.db, 'u1', 'h')).toBe(5)
    expect(defs.update.handler(ctx, { user_id: 'u2', file_path_hash: 'h', last_position: 9 }))
      .rejects.toThrow('Authentication failed')
  })

  test('an unresolved caller matches nothing', async () => {
    const defs = build(null)
    expect(defs.update.handler({ db: db() }, { user_id: 'u1', file_path_hash: 'h', last_position: 5 }))
      .rejects.toThrow('Authentication failed')
  })

  test('the read refuses quietly rather than throwing', async () => {
    const ctx = { db: db() }
    await writeSyncCursor(ctx.db, 'u1', 'h', 5)
    const defs = build('u2')
    expect(await defs.read.handler(ctx, { user_id: 'u1', file_path_hash: 'h' })).toBeNull()
  })

  test('the declared arguments follow the configured column names', () => {
    const defs = createSyncCursorDefinitions({
      v,
      resolveOwner: { write: async () => 'a1' },
      config: { ownerField: 'account_id', keyField: 'source', positionField: 'offset' },
    })
    expect(Object.keys(defs.update.args).sort()).toEqual(['account_id', 'api_token', 'offset', 'source'])
  })
})
