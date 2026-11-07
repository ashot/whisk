import { describe, expect, test } from 'bun:test'
import { FakeDb } from './fakeDb'
import { advanceViewRevision, readViewRevision } from './viewRevisions'

const db = () => new FakeDb({}) as any

describe('view revisions', () => {
  test('a view nobody has written is at revision zero', async () => {
    expect(await readViewRevision(db(), 'p1', 'inbox', 'all')).toBe(0)
  })

  test('advancing creates the head, then counts up', async () => {
    const d = db()
    expect(await advanceViewRevision(d, 'p1', 'inbox', 'all'))
      .toEqual({ contractId: 'inbox', viewKey: 'all', revision: 1 })
    expect(await advanceViewRevision(d, 'p1', 'inbox', 'all'))
      .toEqual({ contractId: 'inbox', viewKey: 'all', revision: 2 })
    expect(await readViewRevision(d, 'p1', 'inbox', 'all')).toBe(2)
    expect(d.tables.local_view_heads).toHaveLength(1)
  })

  test('principal, contract and view key are three separate axes', async () => {
    const d = db()
    await advanceViewRevision(d, 'p1', 'inbox', 'all')
    await advanceViewRevision(d, 'p2', 'inbox', 'all')
    await advanceViewRevision(d, 'p1', 'inbox', 'starred')
    await advanceViewRevision(d, 'p1', 'teams', 'all')
    expect(await readViewRevision(d, 'p1', 'inbox', 'all')).toBe(1)
    expect(await readViewRevision(d, 'p2', 'inbox', 'all')).toBe(1)
    expect(await readViewRevision(d, 'p1', 'inbox', 'starred')).toBe(1)
    expect(await readViewRevision(d, 'p1', 'teams', 'all')).toBe(1)
  })

  test('an app can name its own columns', async () => {
    const d = db()
    const config = {
      table: 'view_heads',
      index: 'by_owner_view',
      principalField: 'account_id',
      contractField: 'contract',
      viewField: 'view',
    }
    await advanceViewRevision(d, 'a1', 'inbox', 'all', config)
    expect(d.tables.view_heads[0]).toMatchObject({
      account_id: 'a1', contract: 'inbox', view: 'all', revision: 1,
    })
    expect(await readViewRevision(d, 'a1', 'inbox', 'all', config)).toBe(1)
  })
})
