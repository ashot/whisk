import { describe, expect, test } from 'bun:test'
import { makeChangeTrackedDb } from './changeLog'
import { FakeDb } from './fakeDb'
import { changeLogConfig, syncLogConfig } from './fixtures'
import {
  appendSyncAction,
  createSyncLogDefinitions,
  emitSyncActions,
  isChurnOnlyPatch,
  makeSyncAckCollector,
  prunablePrefix,
  pruneScope,
  readRangePage,
  readSyncHeads,
  scopesForChange,
  teamScopeKey,
  userScopeKey,
} from './syncLog'

function makeFakeDb() {
  const db = new FakeDb({}, { tableIds: true })
  const actions = (scope?: string) => {
    const all = [...(db.tables.sync_actions ?? [])].sort((a, b) => a.position - b.position)
    return scope ? all.filter((r) => r.scope_key === scope) : all
  }
  const head = (scope: string) =>
    (db.tables.sync_heads ?? []).find((h) => h.scope_key === scope) ?? null
  return { db: db as any, actions, head }
}

const ownerOnly = syncLogConfig.ownerOnlyEntities!

/** The interceptor with both logs on, as an app would wire it. */
const tracked = (db: any, collector = makeSyncAckCollector()) =>
  makeChangeTrackedDb(db, { changeLog: changeLogConfig, syncLog: syncLogConfig }, collector)

describe('scopesForChange', () => {
  test('tasks land in owner and team scopes', () => {
    expect(scopesForChange('tasks', { owner_user_id: 'users:1', team_id: 'teams:9' }, ownerOnly))
      .toEqual(['user:users:1', 'team:teams:9'])
  })
  test('an owner-only type stays owner-only even with a team', () => {
    expect(scopesForChange('conversations', { owner_user_id: 'users:1', team_id: 'teams:9' }, ownerOnly))
      .toEqual(['user:users:1'])
  })
  test('no owner means no scopes (already-gone row)', () => {
    expect(scopesForChange('tasks', { owner_user_id: undefined, team_id: 'teams:9' }, ownerOnly))
      .toEqual([])
  })
  test('an app that marks nothing owner-only fans every type to its team', () => {
    expect(scopesForChange('conversations', { owner_user_id: 'users:1', team_id: 'teams:9' }))
      .toEqual(['user:users:1', 'team:teams:9'])
  })
})

describe('appendSyncAction — ordering and coalescing', () => {
  test('positions are strictly increasing per scope in append order', async () => {
    const { db, actions, head } = makeFakeDb()
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:1', 'upsert')
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:2', 'upsert')
    await appendSyncAction(db, null, 'user:u1', 'docs', 'docs:1', 'upsert')
    expect(actions('user:u1').map((r) => r.position)).toEqual([1, 2, 3])
    expect(head('user:u1')?.position).toBe(3)
  })

  test('scopes have independent counters', async () => {
    const { db, head } = makeFakeDb()
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:1', 'upsert')
    await appendSyncAction(db, null, 'team:t1', 'tasks', 'tasks:1', 'upsert')
    expect(head('user:u1')?.position).toBe(1)
    expect(head('team:t1')?.position).toBe(1)
  })

  test('a re-written entity MOVES its row to the new head instead of appending', async () => {
    const { db, actions, head } = makeFakeDb()
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:1', 'upsert')
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:2', 'upsert')
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:1', 'upsert') // separate txn
    const rows = actions('user:u1')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => [r.entity_id, r.position])).toEqual([
      ['tasks:2', 2],
      ['tasks:1', 3],
    ])
    expect(head('user:u1')?.position).toBe(3)
  })

  test('a reader whose cursor already passed the entity sees it again after the move', async () => {
    const { db, actions } = makeFakeDb()
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:1', 'upsert') // position 1
    const cursorAfterFirstApply = 1
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:1', 'upsert') // moves to 2
    const unseen = actions('user:u1').filter((r) => r.position > cursorAfterFirstApply)
    expect(unseen.map((r) => r.entity_id)).toEqual(['tasks:1'])
  })

  test('delete flips the entity active row in place at the new head', async () => {
    const { db, actions } = makeFakeDb()
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:1', 'upsert')
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:1', 'delete')
    const rows = actions('user:u1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ entity_id: 'tasks:1', op: 'delete', position: 2 })
  })

  test('scope lifecycle actions always insert (never coalesce with entity rows)', async () => {
    const { db, actions } = makeFakeDb()
    await appendSyncAction(db, null, 'user:u1', 'scope', 'teams:9', 'scope_added')
    await appendSyncAction(db, null, 'user:u1', 'scope', 'teams:9', 'scope_removed')
    expect(actions('user:u1').map((r) => r.op)).toEqual(['scope_added', 'scope_removed'])
  })

  test('collector dedupes repeated identical appends within one transaction', async () => {
    const { db, actions } = makeFakeDb()
    const collector = makeSyncAckCollector()
    await appendSyncAction(db, collector, 'user:u1', 'tasks', 'tasks:1', 'upsert')
    await appendSyncAction(db, collector, 'user:u1', 'tasks', 'tasks:1', 'upsert')
    expect(actions('user:u1')).toHaveLength(1)
    expect(collector.positions).toEqual([{ scope_key: 'user:u1', position: 1 }])
  })
})

describe('emitSyncActions — scope moves', () => {
  test('moving a task between teams revokes in the departed scope', async () => {
    const { db, actions } = makeFakeDb()
    await emitSyncActions(db, null, 'tasks', 'tasks:1', 'upsert',
      { owner_user_id: 'users:1', team_id: 'teams:a' }, null, syncLogConfig)
    await emitSyncActions(db, null, 'tasks', 'tasks:1', 'upsert',
      { owner_user_id: 'users:1', team_id: 'teams:b' },
      { owner_user_id: 'users:1', team_id: 'teams:a' }, syncLogConfig)
    const departed = actions(teamScopeKey('teams:a'))
    expect(departed).toHaveLength(1)
    expect(departed[0]!.op).toBe('delete')
    const entered = actions(teamScopeKey('teams:b'))
    expect(entered).toHaveLength(1)
    expect(entered[0]!.op).toBe('upsert')
    // The owner scope keeps one moved upsert row.
    const owner = actions(userScopeKey('users:1'))
    expect(owner).toHaveLength(1)
    expect(owner[0]!.op).toBe('upsert')
  })

  test('unchanged scope emits no revocation', async () => {
    const { db, actions } = makeFakeDb()
    await emitSyncActions(db, null, 'tasks', 'tasks:1', 'upsert',
      { owner_user_id: 'users:1', team_id: 'teams:a' },
      { owner_user_id: 'users:1', team_id: 'teams:a' }, syncLogConfig)
    expect(actions(teamScopeKey('teams:a')).map((r) => r.op)).toEqual(['upsert'])
  })
})

describe('makeChangeTrackedDb — dual emission through the interceptor', () => {
  test('tracked insert writes both logs and collects a position', async () => {
    const { db, actions } = makeFakeDb()
    const collector = makeSyncAckCollector()
    const tdb = tracked(db, collector)
    const id = await tdb.insert('tasks', { user_id: 'users:1', team_id: 'teams:9' })
    expect(actions(userScopeKey('users:1')).map((r) => r.entity_id)).toEqual([String(id)])
    expect(actions(teamScopeKey('teams:9')).map((r) => r.entity_id)).toEqual([String(id)])
    expect(collector.positions).toEqual([
      { scope_key: 'user:users:1', position: 1 },
      { scope_key: 'team:teams:9', position: 1 },
    ])
  })

  test('patch that moves team emits revocation in the departed team scope', async () => {
    const { db, actions } = makeFakeDb()
    const tdb = tracked(db)
    const id = await tdb.insert('tasks', { user_id: 'users:1', team_id: 'teams:a' })
    const tdb2 = tracked(db) // fresh transaction
    await tdb2.patch(id, { team_id: 'teams:b' })
    const departed = actions(teamScopeKey('teams:a'))
    expect(departed).toHaveLength(1)
    expect(departed[0]!.op).toBe('delete')
    expect(actions(teamScopeKey('teams:b')).map((r) => r.op)).toEqual(['upsert'])
  })

  test('ordinary semantic patch stays in scope and just moves the row forward', async () => {
    const { db, actions, head } = makeFakeDb()
    const tdb = tracked(db)
    const id = await tdb.insert('conversations', { user_id: 'users:1' })
    await tracked(db).patch(id, { title: 'one' })
    await tracked(db).patch(id, { inbox_dismissed_at: 42 })
    const rows = actions(userScopeKey('users:1'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.position).toBe(3)
    expect(head(userScopeKey('users:1'))?.position).toBe(3)
  })

  test('delete emits a delete action in every visible scope', async () => {
    const { db, actions } = makeFakeDb()
    const tdb = tracked(db)
    const id = await tdb.insert('docs', { user_id: 'users:1', team_id: 'teams:9' })
    await tracked(db).delete(id)
    expect(actions(userScopeKey('users:1')).map((r) => r.op)).toEqual(['delete'])
    expect(actions(teamScopeKey('teams:9')).map((r) => r.op)).toEqual(['delete'])
  })

  test('membership insert/delete emits scope lifecycle actions in the member scope', async () => {
    const { db, actions } = makeFakeDb()
    const tdb = tracked(db)
    const mid = await tdb.insert('team_memberships', {
      user_id: 'users:7', team_id: 'teams:9', role: 'member',
    })
    await tracked(db).delete(mid)
    expect(actions(userScopeKey('users:7')).map((r) => [r.entity_type, r.op])).toEqual([
      ['scope', 'scope_added'],
      ['scope', 'scope_removed'],
    ])
  })

  test('an owner-only type never emits into the team scope', async () => {
    const { db, actions } = makeFakeDb()
    await tracked(db).insert('conversations', { user_id: 'users:1', team_id: 'teams:9' })
    expect(actions(teamScopeKey('teams:9'))).toHaveLength(0)
    expect(actions(userScopeKey('users:1'))).toHaveLength(1)
  })

  test('the change log alone runs without a sync log configured', async () => {
    const { db, actions } = makeFakeDb()
    const tdb = makeChangeTrackedDb(db, { changeLog: changeLogConfig })
    await tdb.insert('tasks', { user_id: 'users:1', team_id: 'teams:9' })
    expect(actions()).toHaveLength(0)
    expect(db.tables.change_log).toHaveLength(1)
  })
})

describe('churn exemption', () => {
  test('counter and liveness only patches emit no sync action', async () => {
    const { db, actions } = makeFakeDb()
    const tdb = tracked(db)
    const id = await tdb.insert('conversations', { user_id: 'users:1' })
    const before = [...actions(userScopeKey('users:1'))]
    await tracked(db).patch(id, { message_count: 7, updated_at: 123, last_heartbeat: 456 })
    expect(actions(userScopeKey('users:1'))).toEqual(before) // no move, no append
  })

  test('a mixed patch (churn plus a semantic field) still emits', async () => {
    const { db, actions } = makeFakeDb()
    const tdb = tracked(db)
    const id = await tdb.insert('conversations', { user_id: 'users:1' })
    await tracked(db).patch(id, { message_count: 7, inbox_dismissed_at: 999 })
    expect(actions(userScopeKey('users:1'))[0]!.position).toBe(2)
  })

  test('isChurnOnlyPatch: only listed tables, only full churn key sets', () => {
    const churn = syncLogConfig.churnOnlyFields
    expect(isChurnOnlyPatch('conversations', { message_count: 1 }, churn)).toBe(true)
    expect(isChurnOnlyPatch('conversations', { message_count: 1, title: 'x' }, churn)).toBe(false)
    expect(isChurnOnlyPatch('conversations', {}, churn)).toBe(false)
    expect(isChurnOnlyPatch('tasks', { updated_at: 1 }, churn)).toBe(false)
    // No catalog means nothing is exempt.
    expect(isChurnOnlyPatch('conversations', { message_count: 1 })).toBe(false)
  })
})

describe('kill switch', () => {
  test('SYNC_LOG_DISABLED=1 stops emission without touching the change log', async () => {
    const prev = process.env.SYNC_LOG_DISABLED
    process.env.SYNC_LOG_DISABLED = '1'
    try {
      const { db, actions } = makeFakeDb()
      await tracked(db).insert('tasks', { user_id: 'users:1' })
      expect(actions()).toHaveLength(0)
      expect(db.tables.change_log).toHaveLength(1)
    } finally {
      if (prev === undefined) delete process.env.SYNC_LOG_DISABLED
      else process.env.SYNC_LOG_DISABLED = prev
    }
  })
})

describe('scope move sequences', () => {
  test('move plus an unrelated patch in ONE transaction keeps the revocation', async () => {
    const { db, actions } = makeFakeDb()
    const tdb = tracked(db)
    const id = await tdb.insert('docs', { user_id: 'users:1', team_id: 'teams:a' })
    const tdb2 = tracked(db)
    await tdb2.patch(id, { team_id: 'teams:b' })
    await tdb2.patch(id, { title: 'renamed' })
    expect(actions(teamScopeKey('teams:a')).map((r) => r.op)).toEqual(['delete'])
    expect(actions(teamScopeKey('teams:b')).map((r) => r.op)).toEqual(['upsert'])
    expect(actions(userScopeKey('users:1')).map((r) => r.op)).toEqual(['upsert'])
  })

  test('a double move leaves revocations in both departed scopes', async () => {
    const { db, actions } = makeFakeDb()
    const id = await tracked(db).insert('docs', { user_id: 'users:1', team_id: 'teams:a' })
    await tracked(db).patch(id, { team_id: 'teams:b' })
    await tracked(db).patch(id, { team_id: 'teams:c' })
    expect(actions(teamScopeKey('teams:a')).map((r) => r.op)).toEqual(['delete'])
    expect(actions(teamScopeKey('teams:b')).map((r) => r.op)).toEqual(['delete'])
    expect(actions(teamScopeKey('teams:c')).map((r) => r.op)).toEqual(['upsert'])
  })
})

describe('allocatePosition — sub mutation safety', () => {
  test('a second collector bumping between a parent writes never mints a duplicate', async () => {
    const { db, actions, head } = makeFakeDb()
    const parent = makeSyncAckCollector()
    // The parent writes, caching the head at position 1.
    await appendSyncAction(db, parent, 'user:u1', 'tasks', 'tasks:1', 'upsert')
    // A sub mutation with its OWN collector bumps the same scope, same
    // transaction, same db.
    const child = makeSyncAckCollector()
    await appendSyncAction(db, child, 'user:u1', 'tasks', 'tasks:2', 'upsert')
    // The parent writes again from its stale cache: it must re read, not reuse.
    await appendSyncAction(db, parent, 'user:u1', 'docs', 'docs:1', 'upsert')
    const positions = actions('user:u1').map((r) => r.position).sort((a, b) => a - b)
    expect(positions).toEqual([1, 2, 3])
    expect(head('user:u1')?.position).toBe(3)
  })
})

describe('readSyncHeads', () => {
  test('reports each scope position and floor, zero for an untouched scope', async () => {
    const { db } = makeFakeDb()
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:1', 'upsert')
    const { heads } = await readSyncHeads(db, ['user:u1', 'team:t9'])
    expect(heads).toEqual([
      { scope_key: 'user:u1', position: 1, floor: 0 },
      { scope_key: 'team:t9', position: 0, floor: 0 },
    ])
  })
})

describe('readRangePage', () => {
  const seed = async (db: any, n: number) => {
    for (let i = 1; i <= n; i++) {
      await appendSyncAction(db, null, 'user:u1', 'tasks', `tasks:${i}`, 'upsert')
    }
  }
  test('pages ascending with hasMore and nextFrom', async () => {
    const { db } = makeFakeDb()
    await seed(db, 5)
    const p1 = await readRangePage(db, 'user:u1', 0, 2)
    expect(p1.actions.map((a) => a.position)).toEqual([1, 2])
    expect(p1.hasMore).toBe(true)
    expect(p1.nextFrom).toBe(2)
    const p2 = await readRangePage(db, 'user:u1', p1.nextFrom, 100)
    expect(p2.actions.map((a) => a.position)).toEqual([3, 4, 5])
    expect(p2.hasMore).toBe(false)
    expect(p2.nextFrom).toBe(5)
  })
  test('floor above the cursor returns resync', async () => {
    const { db, head } = makeFakeDb()
    await seed(db, 3)
    head('user:u1')!.floor = 2
    expect((await readRangePage(db, 'user:u1', 1, 10)).resync).toBe(true)
    // A cursor exactly at the floor is fine: floor rows are deleted and the
    // range is gt(floor).
    expect((await readRangePage(db, 'user:u1', 2, 10)).resync).toBeUndefined()
  })
  test('an empty scope with no head is caught up at 0', async () => {
    const { db } = makeFakeDb()
    const r = await readRangePage(db, 'user:u1', 0, 10)
    expect(r).toMatchObject({ actions: [], nextFrom: 0, hasMore: false })
  })
})

describe('the sync log definitions', () => {
  const v = { string: () => 's', number: () => 'n', optional: (i: string) => `o<${i}>` }
  const build = (userId: unknown, scopes: string[]) =>
    createSyncLogDefinitions({
      v,
      resolveUser: async () => userId,
      scopeKeys: async () => scopes,
    })

  test('heads reports every scope the caller holds', async () => {
    const { db } = makeFakeDb()
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:1', 'upsert')
    const defs = build('u1', ['user:u1', 'team:t1'])
    expect(await defs.heads.handler({ db })).toEqual({
      heads: [
        { scope_key: 'user:u1', position: 1, floor: 0 },
        { scope_key: 'team:t1', position: 0, floor: 0 },
      ],
    })
  })

  test('a scope the caller does not hold reads as unauthorized, not as caught up', async () => {
    const { db } = makeFakeDb()
    await appendSyncAction(db, null, 'team:t9', 'tasks', 'tasks:1', 'upsert')
    const defs = build('u1', ['user:u1'])
    expect(await defs.range.handler({ db }, { scope_key: 'team:t9', from: 0 }))
      .toEqual({ actions: [], nextFrom: 0, hasMore: false, authorized: false })
    // The same read of a held scope is an ordinary page.
    const held = await defs.range.handler({ db }, { scope_key: 'user:u1', from: 0 })
    expect(held.authorized).toBeUndefined()
  })

  test('an unresolved caller reads nothing', async () => {
    const { db } = makeFakeDb()
    const defs = build(null, ['user:u1'])
    expect(await defs.heads.handler({ db })).toEqual({ heads: [] })
    expect(await defs.range.handler({ db }, { scope_key: 'user:u1', from: 3 }))
      .toEqual({ actions: [], nextFrom: 3, hasMore: false })
  })
})

describe('retention', () => {
  test('prunablePrefix deletes the old prefix and stops at the first young row', () => {
    const { toDelete, stoppedEarly } = prunablePrefix([{ ts: 1 }, { ts: 2 }, { ts: 100 }, { ts: 3 }], 50)
    expect(toDelete).toEqual([{ ts: 1 }, { ts: 2 }])
    expect(stoppedEarly).toBe(true)
  })
  test('prunablePrefix consumes the whole page when everything is old', () => {
    const { toDelete, stoppedEarly } = prunablePrefix([{ ts: 1 }, { ts: 2 }], 50)
    expect(toDelete).toHaveLength(2)
    expect(stoppedEarly).toBe(false)
  })
  test('an empty page is not an early stop', () => {
    const { toDelete, stoppedEarly } = prunablePrefix([], 50)
    expect(toDelete).toHaveLength(0)
    expect(stoppedEarly).toBe(false)
  })
  test('a drained scope raises the floor to the head, so a stale cursor resyncs', async () => {
    const { db, head } = makeFakeDb()
    const old = { ...syncLogConfig, now: () => 1000 }
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:1', 'upsert', old)
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:2', 'upsert', old)
    const r = await pruneScope(db, head('user:u1')! as any, 5000, 100)
    expect(r.pruned).toBe(2)
    expect(head('user:u1')?.floor).toBe(2)
    expect((await readRangePage(db, 'user:u1', 1, 10)).resync).toBe(true)
  })
  test('a young scope costs one probe and prunes nothing', async () => {
    const { db, head } = makeFakeDb()
    await appendSyncAction(db, null, 'user:u1', 'tasks', 'tasks:1', 'upsert')
    const r = await pruneScope(db, head('user:u1')! as any, 0, 100)
    expect(r).toMatchObject({ pruned: 0, done: true })
    expect(head('user:u1')?.floor).toBe(0)
  })
})
