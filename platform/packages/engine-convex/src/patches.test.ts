import { describe, expect, test } from 'bun:test'
import { fakeCtx } from './fakeDb'
import { applyPatches, collection, deepMergeBag, isConvexId, singleton, sideEffectPayload } from './patches'

const CONVEX_ID = 'a'.repeat(32)
const now = () => 1000

const tables = {
  blocks: collection(['status', 'note'], ['minutes'], { scopeField: 'child_id' }),
  client_state: singleton(['theme', 'last_view'], {
    ownerField: 'account_id',
    lookupIndex: 'by_account',
    overflowField: 'prefs',
  }),
}

describe('applyPatches', () => {
  test('writes declared fields and stamps updated_at', async () => {
    const ctx = fakeCtx({ blocks: [{ _id: CONVEX_ID, account_id: 'acct1', child_id: 'kid1', status: 'todo' }] })
    await applyPatches(ctx, tables, 'acct1', { blocks: { [CONVEX_ID]: { status: 'done' } } }, { scopeField: 'child_id', now })
    const row = await ctx.raw.get(CONVEX_ID)
    expect(row.status).toBe('done')
    expect(row.updated_at).toBe(1000)
  })

  test('drops undeclared fields on a table with no overflow bag', async () => {
    const ctx = fakeCtx({ blocks: [{ _id: CONVEX_ID, account_id: 'acct1', child_id: 'kid1', status: 'todo' }] })
    await applyPatches(ctx, tables, 'acct1', { blocks: { [CONVEX_ID]: { status: 'done', sneaky: 'x' } } }, { scopeField: 'child_id', now })
    const row = await ctx.raw.get(CONVEX_ID)
    expect(row.sneaky).toBeUndefined()
  })

  test('ignores immutable fields even when named', async () => {
    const ctx = fakeCtx({ blocks: [{ _id: CONVEX_ID, account_id: 'acct1', child_id: 'kid1', status: 'todo' }] })
    await applyPatches(
      ctx, tables, 'acct1',
      { blocks: { [CONVEX_ID]: { status: 'done', account_id: 'acct2', child_id: 'kid2', minutes: 99 } } },
      { scopeField: 'child_id', now },
    )
    const row = await ctx.raw.get(CONVEX_ID)
    expect(row.account_id).toBe('acct1')
    expect(row.child_id).toBe('kid1')
    expect(row.minutes).toBeUndefined()
  })

  test('skips a row owned by someone else', async () => {
    const ctx = fakeCtx({ blocks: [{ _id: CONVEX_ID, account_id: 'other', child_id: 'kid1', status: 'todo' }] })
    await applyPatches(ctx, tables, 'acct1', { blocks: { [CONVEX_ID]: { status: 'done' } } }, { scopeField: 'child_id', now })
    const row = await ctx.raw.get(CONVEX_ID)
    expect(row.status).toBe('todo')
  })

  test('skips a table absent from the allowlist', async () => {
    const ctx = fakeCtx({ secrets: [{ _id: CONVEX_ID, account_id: 'acct1', value: 'keep' }] })
    await applyPatches(ctx, tables, 'acct1', { secrets: { [CONVEX_ID]: { value: 'stolen' } } }, { now })
    expect((await ctx.raw.get(CONVEX_ID)).value).toBe('keep')
  })

  test('a stub id creates the row and reports it with its client_id', async () => {
    const ctx = fakeCtx({})
    const inserted = await applyPatches(
      ctx, tables, 'acct1',
      { blocks: { 'stub_1': { status: 'todo', client_id: 'stub_1', child_id: 'kid1' } } },
      { scopeField: 'child_id', now },
    )
    expect(inserted.blocks).toHaveLength(1)
    expect(inserted.blocks![0]!.client_id).toBe('stub_1')
    const row = await ctx.raw.get(inserted.blocks![0]!.id)
    expect(row.account_id).toBe('acct1')
    expect(row.child_id).toBe('kid1')
  })

  test('refuses to create a row with no scope', async () => {
    const ctx = fakeCtx({})
    const inserted = await applyPatches(
      ctx, tables, 'acct1',
      { blocks: { 'stub_1': { status: 'todo' } } },
      { scopeField: 'child_id', now },
    )
    expect(inserted.blocks).toBeUndefined()
    expect(ctx.raw.tables.blocks ?? []).toHaveLength(0)
  })

  test('singleton upserts, then patches in place', async () => {
    const ctx = fakeCtx({})
    await applyPatches(ctx, tables, 'acct1', { client_state: { any: { theme: 'dark' } } }, { now })
    expect(ctx.raw.tables.client_state).toHaveLength(1)
    await applyPatches(ctx, tables, 'acct1', { client_state: { any: { theme: 'light' } } }, { now })
    expect(ctx.raw.tables.client_state).toHaveLength(1)
    expect(ctx.raw.tables.client_state![0]!.theme).toBe('light')
  })

  test('undeclared fields land in the overflow bag and merge across writes', async () => {
    const ctx = fakeCtx({})
    await applyPatches(ctx, tables, 'acct1', { client_state: { any: { newToggle: true } } }, { now })
    expect(ctx.raw.tables.client_state![0]!.prefs).toEqual({ newToggle: true })
    await applyPatches(ctx, tables, 'acct1', { client_state: { any: { other: 1 } } }, { now })
    expect(ctx.raw.tables.client_state![0]!.prefs).toEqual({ newToggle: true, other: 1 })
  })

  test('a null in the overflow bag clears its key', async () => {
    const ctx = fakeCtx({})
    await applyPatches(ctx, tables, 'acct1', { client_state: { any: { a: 1, b: 2 } } }, { now })
    await applyPatches(ctx, tables, 'acct1', { client_state: { any: { a: null } } }, { now })
    expect(ctx.raw.tables.client_state![0]!.prefs).toEqual({ b: 2 })
  })

  test('a null on a declared field clears it', async () => {
    const ctx = fakeCtx({ blocks: [{ _id: CONVEX_ID, account_id: 'acct1', child_id: 'kid1', note: 'x' }] })
    await applyPatches(ctx, tables, 'acct1', { blocks: { [CONVEX_ID]: { note: null } } }, { scopeField: 'child_id', now })
    expect((await ctx.raw.get(CONVEX_ID)).note).toBeUndefined()
  })

  test('a collection with an overflow bag keeps undeclared fields and merges over the stored bag', async () => {
    const bagTables = {
      notes: collection(['title'], [], { scopeField: 'child_id', overflowField: 'extra' }),
    }
    const ctx = fakeCtx({
      notes: [{ _id: CONVEX_ID, account_id: 'acct1', child_id: 'kid1', extra: { kept: 1 } }],
    })
    await applyPatches(
      ctx, bagTables, 'acct1',
      { notes: { [CONVEX_ID]: { title: 't', newToggle: true } } },
      { scopeField: 'child_id', now },
    )
    const row = await ctx.raw.get(CONVEX_ID)
    expect(row.title).toBe('t')
    expect(row.extra).toEqual({ kept: 1, newToggle: true })
  })

  test('an overflow-only patch creates a collection row carrying the bag', async () => {
    const bagTables = {
      notes: collection(['title'], [], { scopeField: 'child_id', overflowField: 'extra' }),
    }
    const ctx = fakeCtx({})
    await applyPatches(
      ctx, bagTables, 'acct1',
      { notes: { stub: { child_id: 'kid1', newToggle: true } } },
      { scopeField: 'child_id', now },
    )
    expect(ctx.raw.tables.notes![0]!.extra).toEqual({ newToggle: true })
  })

  test('a patch of only rejected fields writes nothing at all', async () => {
    const ctx = fakeCtx({ blocks: [{ _id: CONVEX_ID, account_id: 'acct1', child_id: 'kid1', status: 'todo' }] })
    await applyPatches(ctx, tables, 'acct1', { blocks: { [CONVEX_ID]: { minutes: 5 } } }, { scopeField: 'child_id', now })
    expect((await ctx.raw.get(CONVEX_ID)).updated_at).toBeUndefined()
  })
})

describe('scope ownership on create', () => {
  const stub = 'stub_new'
  const owned = async (ctx: any, scopeId: unknown, ownerId: unknown) => {
    const kid = ctx.db.rows?.('children')?.find((c: any) => c._id === scopeId) ?? (await ctx.db.get(scopeId as any))
    return !!kid && kid.account_id === ownerId
  }

  test('a create under the owner\'s own child lands', async () => {
    const ctx = fakeCtx({ children: [{ _id: 'kid1', account_id: 'acct1' }] })
    const inserted = await applyPatches(ctx, tables, 'acct1',
      { blocks: { [stub]: { status: 'todo', child_id: 'kid1', client_id: stub } } },
      { scopeField: 'child_id', now, scopeOwned: owned })
    expect(inserted.blocks?.length).toBe(1)
  })

  test('a create under another account\'s child is skipped', async () => {
    const ctx = fakeCtx({ children: [{ _id: 'kid2', account_id: 'acct2' }] })
    const inserted = await applyPatches(ctx, tables, 'acct1',
      { blocks: { [stub]: { status: 'todo', child_id: 'kid2', client_id: stub } } },
      { scopeField: 'child_id', now, scopeOwned: owned })
    expect(inserted.blocks ?? []).toHaveLength(0)
  })
})

describe('beforePatch', () => {
  const hookTables = (hook: NonNullable<ReturnType<typeof collection>['beforePatch']>) => ({
    blocks: collection(['status', 'note'], ['minutes'], { scopeField: 'child_id', beforePatch: hook }),
    plain: collection(['status'], [], { scopeField: 'child_id' }),
  })

  test('rewrites a field on update, with the stored row in hand', async () => {
    const seen: Array<{ doc: any; safe: Record<string, unknown> }> = []
    const tables = hookTables((doc, safe) => {
      seen.push({ doc, safe: { ...safe } })
      if (safe.status === 'done') safe.note = `was ${doc.status}`
      return safe
    })
    const ctx = fakeCtx({ blocks: [{ _id: CONVEX_ID, account_id: 'acct1', child_id: 'kid1', status: 'todo' }] })
    await applyPatches(ctx, tables, 'acct1', { blocks: { [CONVEX_ID]: { status: 'done' } } }, { scopeField: 'child_id', now })
    const row = await ctx.raw.get(CONVEX_ID)
    expect(row.status).toBe('done')
    expect(row.note).toBe('was todo')
    expect(seen[0]!.doc._id).toBe(CONVEX_ID)
  })

  test('rewrites a field on insert, with null for the missing row', async () => {
    const docs: unknown[] = []
    const tables = hookTables((doc, safe) => {
      docs.push(doc)
      safe.status = 'queued'
      return safe
    })
    const ctx = fakeCtx({})
    const inserted = await applyPatches(
      ctx, tables, 'acct1',
      { blocks: { stub_1: { status: 'todo', client_id: 'stub_1', child_id: 'kid1' } } },
      { scopeField: 'child_id', now },
    )
    expect(docs).toEqual([null])
    const row = await ctx.raw.get(inserted.blocks![0]!.id)
    expect(row.status).toBe('queued')
    expect(row.account_id).toBe('acct1')
    expect(row.child_id).toBe('kid1')
  })

  test('runs after the immutable and declared filters and the ownership check', async () => {
    const calls: Array<Record<string, unknown>> = []
    const tables = hookTables((_doc, safe) => {
      calls.push({ ...safe })
      return safe
    })
    const ctx = fakeCtx({
      blocks: [
        { _id: CONVEX_ID, account_id: 'acct1', child_id: 'kid1', status: 'todo' },
        { _id: 'b'.repeat(32), account_id: 'other', child_id: 'kid1', status: 'todo' },
      ],
    })
    await applyPatches(
      ctx, tables, 'acct1',
      {
        blocks: {
          // Immutable (account_id, minutes) and undeclared (sneaky) fields are
          // gone before the hook sees the patch.
          [CONVEX_ID]: { status: 'done', account_id: 'acct2', minutes: 99, sneaky: 'x' },
          // A row owned by someone else never reaches the hook.
          ['b'.repeat(32)]: { status: 'done' },
        },
      },
      { scopeField: 'child_id', now },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ status: 'done', updated_at: 1000 })
    expect((await ctx.raw.get('b'.repeat(32))).status).toBe('todo')
  })

  test('an empty return cancels the write; the hook cannot move a create across owners', async () => {
    const tables = hookTables((doc) => (doc ? {} : { account_id: 'acct2', status: 'x' }))
    const ctx = fakeCtx({ blocks: [{ _id: CONVEX_ID, account_id: 'acct1', child_id: 'kid1', status: 'todo' }] })
    await applyPatches(ctx, tables, 'acct1', { blocks: { [CONVEX_ID]: { status: 'done' } } }, { scopeField: 'child_id', now })
    const row = await ctx.raw.get(CONVEX_ID)
    expect(row.status).toBe('todo')
    expect(row.updated_at).toBeUndefined()
    const inserted = await applyPatches(
      ctx, tables, 'acct1',
      { blocks: { stub_1: { status: 'todo', child_id: 'kid1' } } },
      { scopeField: 'child_id', now },
    )
    expect((await ctx.raw.get(inserted.blocks![0]!.id)).account_id).toBe('acct1')
  })

  test('a table without a hook is untouched in the same pass', async () => {
    const tables = hookTables((_doc, safe) => ({ ...safe, status: 'rewritten' }))
    const otherId = 'c'.repeat(32)
    const ctx = fakeCtx({
      blocks: [{ _id: CONVEX_ID, account_id: 'acct1', child_id: 'kid1', status: 'todo' }],
      plain: [{ _id: otherId, account_id: 'acct1', child_id: 'kid1', status: 'todo' }],
    })
    await applyPatches(
      ctx, tables, 'acct1',
      {
        blocks: { [CONVEX_ID]: { status: 'done' } },
        plain: { [otherId]: { status: 'done' } },
      },
      { scopeField: 'child_id', now },
    )
    expect((await ctx.raw.get(CONVEX_ID)).status).toBe('rewritten')
    expect((await ctx.raw.get(otherId)).status).toBe('done')
  })
})

describe('helpers', () => {
  test('isConvexId separates real ids from client stubs', () => {
    expect(isConvexId(CONVEX_ID)).toBe(true)
    expect(isConvexId('stub_1')).toBe(false)
    expect(isConvexId('A'.repeat(32))).toBe(false)
  })

  test('sideEffectPayload takes the first argument only', () => {
    expect(sideEffectPayload([{ a: 1 }, 'Archived'])).toEqual({ a: 1 })
    expect(sideEffectPayload({ a: 1 })).toEqual({ a: 1 })
    expect(sideEffectPayload('nope')).toEqual({})
    expect(sideEffectPayload(undefined)).toEqual({})
  })

  test('deepMergeBag replaces rather than merges non-objects', () => {
    expect(deepMergeBag({ a: 1 }, 'x')).toBe('x')
    expect(deepMergeBag([1], { a: 1 })).toEqual({ a: 1 })
  })
})
