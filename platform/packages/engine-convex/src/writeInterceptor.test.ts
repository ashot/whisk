import { describe, expect, test } from 'bun:test'
import { FakeDb } from './fakeDb'
import { changeLogConfig, syncLogConfig } from './fixtures'
import { createTrackedBuilders, syncAckPositions, trackedCtx } from './writeInterceptor'

/** Stands in for a generated builder: hand back the definition unchanged. */
const passThrough = (def: any) => def

const tracking = { changeLog: changeLogConfig, syncLog: syncLogConfig }

function ctx() {
  const db = new FakeDb({}, { tableIds: true })
  return { db: db as any, auth: 'carried through', raw: db }
}

describe('createTrackedBuilders', () => {
  test('a mutation written through the builder emits both logs', async () => {
    const { mutation } = createTrackedBuilders({ mutation: passThrough, tracking })
    const def = mutation({
      args: {},
      handler: async (c: any) => c.db.insert('tasks', { user_id: 'u1', team_id: 't1' }),
    })
    const c = ctx()
    const id = await def.handler(c, {})
    expect(c.raw.tables.change_log).toHaveLength(1)
    expect(c.raw.tables.change_log![0]).toMatchObject({ entity_id: String(id), op: 'upsert' })
    expect(c.raw.tables.sync_actions!.map((r) => r.scope_key).sort())
      .toEqual(['team:t1', 'user:u1'])
  })

  test('a bare handler function is wrapped the same way', async () => {
    const { mutation } = createTrackedBuilders({ mutation: passThrough, tracking })
    const handler = mutation(async (c: any) => c.db.insert('docs', { user_id: 'u1' }))
    const c = ctx()
    await handler(c, {})
    expect(c.raw.tables.change_log).toHaveLength(1)
  })

  test('the rest of the ctx passes through untouched', async () => {
    const { mutation } = createTrackedBuilders({ mutation: passThrough, tracking })
    const def = mutation({ args: {}, handler: async (c: any) => c.auth })
    expect(await def.handler(ctx(), {})).toBe('carried through')
  })

  test('the handler ctx carries the positions this transaction appended', async () => {
    const { mutation } = createTrackedBuilders({ mutation: passThrough, tracking })
    const def = mutation({
      args: {},
      handler: async (c: any) => {
        await c.db.insert('tasks', { user_id: 'u1', team_id: 't1' })
        return syncAckPositions(c)
      },
    })
    expect(await def.handler(ctx(), {})).toEqual([
      { scope_key: 'user:u1', position: 1 },
      { scope_key: 'team:t1', position: 1 },
    ])
  })

  test('a ctx that never went through the builders reports no positions', () => {
    expect(syncAckPositions(ctx())).toEqual([])
  })

  test('each invocation gets a fresh collector, so a retry starts clean', async () => {
    const { mutation } = createTrackedBuilders({ mutation: passThrough, tracking })
    const def = mutation({
      args: {},
      handler: async (c: any) => {
        await c.db.insert('tasks', { user_id: 'u1' })
        return syncAckPositions(c)
      },
    })
    const c = ctx()
    const first = await def.handler(c, {})
    const second = await def.handler(c, {})
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
  })

  test('internalMutation falls back to the mutation builder when none is given', async () => {
    const { internalMutation } = createTrackedBuilders({ mutation: passThrough, tracking })
    const def = internalMutation({
      args: {},
      handler: async (c: any) => c.db.insert('plans', { user_id: 'u1' }),
    })
    const c = ctx()
    await def.handler(c, {})
    expect(c.raw.tables.change_log).toHaveLength(1)
  })

  test('extra wrappers are applied outward, and see the tracked db', async () => {
    const seen: string[] = []
    const outer = (db: any) => ({
      ...db,
      insert: async (table: string, doc: any) => {
        seen.push(table)
        return db.insert(table, doc)
      },
    })
    const { mutation } = createTrackedBuilders({
      mutation: passThrough,
      tracking,
      wrappers: [outer],
    })
    const def = mutation({
      args: {},
      handler: async (c: any) => c.db.insert('tasks', { user_id: 'u1' }),
    })
    const c = ctx()
    await def.handler(c, {})
    // The outer wrapper saw the domain write; the change log write went to the
    // raw db underneath it and never re-entered.
    expect(seen).toEqual(['tasks'])
    expect(c.raw.tables.change_log).toHaveLength(1)
  })

  test('with no tracking configured the ctx db is only what the wrappers make it', async () => {
    const c = ctx()
    const wrapped = trackedCtx(c, { mutation: passThrough })
    await wrapped.db.insert('tasks', { user_id: 'u1' })
    expect(c.raw.tables.change_log).toBeUndefined()
  })
})
