import { describe, expect, test } from 'bun:test'
import { fakeCtx } from './fakeDb'
import { beginReceipt, finishReceipt } from './receipts'

const config = { table: 'command_receipts', index: 'by_command' }
const now = () => 1000

describe('command receipts', () => {
  test('a fresh command claims a running receipt and proceeds', async () => {
    const ctx = fakeCtx({})
    expect(await beginReceipt(ctx, config, 'acct1', 'cmd1', now)).toBeNull()
    const row = ctx.raw.tables.command_receipts![0]!
    expect(row.status).toBe('running')
    expect(row.command_id).toBe('cmd1')
  })

  test('a settled command replays its result instead of running again', async () => {
    const ctx = fakeCtx({})
    await beginReceipt(ctx, config, 'acct1', 'cmd1', now)
    await finishReceipt(ctx, config, 'acct1', 'cmd1', 'done', { ok: 1 }, undefined, now)
    expect(await beginReceipt(ctx, config, 'acct1', 'cmd1', now)).toEqual({ replay: true, result: { ok: 1 } })
    expect(ctx.raw.tables.command_receipts).toHaveLength(1)
  })

  test('a failed command rethrows its stored error', async () => {
    const ctx = fakeCtx({})
    await beginReceipt(ctx, config, 'acct1', 'cmd1', now)
    await finishReceipt(ctx, config, 'acct1', 'cmd1', 'error', null, 'boom', now)
    expect(beginReceipt(ctx, config, 'acct1', 'cmd1', now)).rejects.toThrow('boom')
  })

  test('a receipt still running falls through and runs again', async () => {
    const ctx = fakeCtx({})
    await beginReceipt(ctx, config, 'acct1', 'cmd1', now)
    expect(await beginReceipt(ctx, config, 'acct1', 'cmd1', now)).toBeNull()
    expect(ctx.raw.tables.command_receipts).toHaveLength(1)
  })

  test('the same command id from another account is a different command', async () => {
    const ctx = fakeCtx({})
    await beginReceipt(ctx, config, 'acct1', 'cmd1', now)
    await finishReceipt(ctx, config, 'acct1', 'cmd1', 'done', { ok: 1 }, undefined, now)
    expect(await beginReceipt(ctx, config, 'acct2', 'cmd1', now)).toBeNull()
    expect(ctx.raw.tables.command_receipts).toHaveLength(2)
  })

  test('a null result replays as null rather than undefined', async () => {
    const ctx = fakeCtx({})
    await beginReceipt(ctx, config, 'acct1', 'cmd1', now)
    await finishReceipt(ctx, config, 'acct1', 'cmd1', 'done', undefined, undefined, now)
    expect(await beginReceipt(ctx, config, 'acct1', 'cmd1', now)).toEqual({ replay: true, result: null })
  })
})
