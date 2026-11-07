import { describe, expect, test } from 'bun:test'
import { fakeCtx } from './fakeDb'
import { createDispatch } from './dispatch'
import { singleton } from './patches'

// The generated builders the apps pass in, reduced to what the engine uses:
// `mutation` keeps the definition, `v` only shapes the args object.
const mutation = (def: any) => def
const validator = () => ({})
const v = { string: validator, any: validator, optional: (x: any) => x }

const tables = {
  client_state: singleton(['theme'], { ownerField: 'user_id', lookupIndex: 'by_user' }),
}

function build(overrides: Record<string, unknown> = {}) {
  const calls: { resolver: number; sideEffect: number; clientResult?: unknown } = {
    resolver: 0,
    sideEffect: 0,
  }
  const dispatch = createDispatch<string>({
    mutation,
    v,
    tables,
    sideEffects: {
      noop: async (_ctx, _actor, _payload, clientResult) => {
        calls.sideEffect += 1
        calls.clientResult = clientResult
        return { ok: true }
      },
    },
    receipts: { table: 'command_receipts', index: 'by_command', ownerField: 'user_id' },
    now: () => 1000,
    async resolveActor() {
      return {
        actor: 'actor',
        ownerId: async () => {
          calls.resolver += 1
          return 'user1'
        },
      }
    },
    ...overrides,
  }) as any
  return { dispatch, calls }
}

describe('lazy ownerId', () => {
  test('a side-effect-only dispatch never invokes the thunk', async () => {
    const ctx = fakeCtx({})
    const { dispatch, calls } = build()
    const out = await dispatch.handler(ctx, { token: 't', action: 'noop' })
    expect(out).toEqual({ ok: true })
    expect(calls.sideEffect).toBe(1)
    expect(calls.resolver).toBe(0)
  })

  test('a patch dispatch with a commandId invokes the thunk exactly once', async () => {
    const ctx = fakeCtx({})
    const { dispatch, calls } = build()
    await dispatch.handler(ctx, {
      token: 't',
      action: 'noop',
      commandId: 'cmd1',
      patches: { client_state: { row: { theme: 'dark' } } },
    })
    // One resolution shared by the receipt claim, the patch pass, and the
    // receipt settle.
    expect(calls.resolver).toBe(1)
    expect(ctx.raw.tables.client_state![0]!.user_id).toBe('user1')
    const receipt = ctx.raw.tables.command_receipts![0]!
    expect(receipt.user_id).toBe('user1')
    expect(receipt.status).toBe('done')
  })

  test('a plain ownerId value passes through unchanged', async () => {
    const ctx = fakeCtx({})
    const { dispatch } = build({
      async resolveActor() {
        return { actor: 'actor', ownerId: 'user2' }
      },
    })
    await dispatch.handler(ctx, {
      token: 't',
      action: 'noop',
      patches: { client_state: { row: { theme: 'light' } } },
    })
    expect(ctx.raw.tables.client_state![0]!.user_id).toBe('user2')
  })
})

// A receipt-aware client action packs its command id into `result` and waits
// for a receipt naming that same id back. Both halves live here, because a
// client that gets either half wrong loses dedupe with no error to show for it.
describe('receipt envelope', () => {
  const envelope = (commandId: string, localResult?: unknown) => ({
    receiptActionVersion: 1,
    commandId,
    ...(localResult !== undefined ? { localResult } : {}),
  })

  test('claims the receipt under the command id carried in result', async () => {
    const ctx = fakeCtx({})
    const { dispatch } = build()
    await dispatch.handler(ctx, { token: 't', action: 'noop', result: envelope('cmd1') })
    const receipt = ctx.raw.tables.command_receipts![0]!
    expect(receipt.command_id).toBe('cmd1')
    expect(receipt.status).toBe('done')
    expect(receipt.result).toEqual({ ok: true })
  })

  test('answers with the receipt the client matches against', async () => {
    const ctx = fakeCtx({})
    const { dispatch } = build()
    const out = await dispatch.handler(ctx, {
      token: 't',
      action: 'noop',
      result: envelope('cmd1'),
    })
    expect(out).toEqual({ commandId: 'cmd1', status: 'acknowledged', result: { ok: true } })
  })

  test('replays a settled command instead of running it again', async () => {
    const ctx = fakeCtx({})
    const { dispatch, calls } = build()
    const first = await dispatch.handler(ctx, {
      token: 't',
      action: 'noop',
      result: envelope('cmd1'),
    })
    const second = await dispatch.handler(ctx, {
      token: 't',
      action: 'noop',
      result: envelope('cmd1'),
    })
    expect(calls.sideEffect).toBe(1)
    expect(second).toEqual(first)
    expect(ctx.raw.tables.command_receipts).toHaveLength(1)
  })

  test('hands the side effect the action result, not the envelope', async () => {
    const ctx = fakeCtx({})
    const { dispatch, calls } = build()
    await dispatch.handler(ctx, {
      token: 't',
      action: 'noop',
      result: envelope('cmd1', { stubId: 'stub-1' }),
    })
    expect(calls.clientResult).toEqual({ stubId: 'stub-1' })
  })

  test('a dispatch without an envelope keeps answering with the bare result', async () => {
    const ctx = fakeCtx({})
    const { dispatch } = build()
    const out = await dispatch.handler(ctx, {
      token: 't',
      action: 'noop',
      result: { plain: true },
    })
    expect(out).toEqual({ ok: true })
    expect(ctx.raw.tables.command_receipts ?? []).toHaveLength(0)
  })
})
