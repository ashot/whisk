import { describe, expect, test } from 'bun:test'
import {
  canonicalCommandArguments,
  commandArgumentsFingerprint,
  echoedCommandIdsForView,
  readCommandReceipt,
  runLocalCommand,
  validateCommandId,
} from './commandState'
import { FakeDb } from './fakeDb'
import { readViewRevision } from './viewRevisions'

const db = () => new FakeDb({}) as any

describe('canonicalCommandArguments', () => {
  test('key order does not change the canonical form', () => {
    expect(canonicalCommandArguments({ b: 1, a: 2 })).toBe(canonicalCommandArguments({ a: 2, b: 1 }))
  })
  test('undefined fields drop out, null stays', () => {
    expect(canonicalCommandArguments({ a: undefined, b: null })).toBe('{"b":null}')
  })
  test('negative zero and positive zero read the same', () => {
    expect(canonicalCommandArguments(-0)).toBe('0')
  })
  test('a cyclic argument is refused', () => {
    const cyclic: any = {}
    cyclic.self = cyclic
    expect(() => canonicalCommandArguments(cyclic)).toThrow('cyclic')
  })
  test('a non-finite number is refused', () => {
    expect(() => canonicalCommandArguments({ n: Infinity })).toThrow('finite')
  })
  test('the refusal carries a code the client can branch on', () => {
    try {
      canonicalCommandArguments({ n: NaN })
      throw new Error('should have refused')
    } catch (err: any) {
      expect(err.data.code).toBe('INVALID_COMMAND_ARGUMENTS')
    }
  })
})

describe('commandArgumentsFingerprint', () => {
  test('same intent, same hash — regardless of key order', async () => {
    expect(await commandArgumentsFingerprint({ a: 1, b: 2 }))
      .toBe(await commandArgumentsFingerprint({ b: 2, a: 1 }))
  })
  test('different intent, different hash', async () => {
    expect(await commandArgumentsFingerprint({ a: 1 }))
      .not.toBe(await commandArgumentsFingerprint({ a: 2 }))
  })
})

describe('validateCommandId', () => {
  test('accepts a canonical id', () => {
    expect(validateCommandId('cmd-1')).toBe('cmd-1')
  })
  test('refuses empty, untrimmed and overlong ids', () => {
    expect(() => validateCommandId('')).toThrow()
    expect(() => validateCommandId(' cmd ')).toThrow()
    expect(() => validateCommandId('x'.repeat(161))).toThrow()
  })
})

const acknowledged = (result: unknown, views: Array<{ contractId: string; viewKey: string }>) =>
  async () => ({ status: 'acknowledged' as const, result, coverageViews: views })

describe('runLocalCommand', () => {
  test('runs once, receipts the outcome, and advances the covered views', async () => {
    const d = db()
    const receipt = await runLocalCommand(
      d,
      { principalId: 'p1', commandId: 'cmd-1', commandName: 'renameTask', arguments: { id: 't1' } },
      acknowledged({ ok: true }, [{ contractId: 'tasks', viewKey: 'all' }]),
    )
    expect(receipt).toMatchObject({
      commandId: 'cmd-1',
      commandName: 'renameTask',
      status: 'acknowledged',
      result: { ok: true },
      retryUntil: null,
    })
    expect(receipt.coverage).toEqual([{ contractId: 'tasks', viewKey: 'all', revision: 1 }])
    expect(await readViewRevision(d, 'p1', 'tasks', 'all')).toBe(1)
  })

  test('the same command id replays its answer instead of running again', async () => {
    const d = db()
    let runs = 0
    const execute = async () => {
      runs++
      return { status: 'acknowledged' as const, result: runs, coverageViews: [] }
    }
    const input = { principalId: 'p1', commandId: 'cmd-1', commandName: 'x', arguments: { a: 1 } }
    const first = await runLocalCommand(d, input, execute)
    const second = await runLocalCommand(d, input, execute)
    expect(runs).toBe(1)
    expect(second.result).toBe(first.result)
    expect(d.tables.local_command_receipts).toHaveLength(1)
  })

  test('reusing an id for different intent is refused', async () => {
    const d = db()
    const input = { principalId: 'p1', commandId: 'cmd-1', commandName: 'x', arguments: { a: 1 } }
    await runLocalCommand(d, input, acknowledged(null, []))
    expect(runLocalCommand(d, { ...input, arguments: { a: 2 } }, acknowledged(null, [])))
      .rejects.toThrow('already bound to different intent')
  })

  test('two principals may hold the same command id', async () => {
    const d = db()
    let runs = 0
    const execute = async () => {
      runs++
      return { status: 'acknowledged' as const, coverageViews: [] }
    }
    await runLocalCommand(d, { principalId: 'p1', commandId: 'c', commandName: 'x', arguments: {} }, execute)
    await runLocalCommand(d, { principalId: 'p2', commandId: 'c', commandName: 'x', arguments: {} }, execute)
    expect(runs).toBe(2)
  })

  test('a rejection is receipted and covers no view', async () => {
    const d = db()
    const receipt = await runLocalCommand(
      d,
      { principalId: 'p1', commandId: 'cmd-1', commandName: 'x', arguments: {} },
      async () => ({ status: 'rejected' as const, code: 'NOT_FOUND', message: 'gone' }),
    )
    expect(receipt.status).toBe('rejected')
    expect(receipt.rejection).toEqual({ code: 'NOT_FOUND', message: 'gone' })
    expect(receipt.coverage).toEqual([])
    expect(d.tables.local_view_heads).toBeUndefined()
  })

  test('duplicate coverage targets advance one revision, not two', async () => {
    const d = db()
    const receipt = await runLocalCommand(
      d,
      { principalId: 'p1', commandId: 'cmd-1', commandName: 'x', arguments: {} },
      acknowledged(null, [
        { contractId: 'tasks', viewKey: 'all' },
        { contractId: 'tasks', viewKey: 'all' },
      ]),
    )
    expect(receipt.coverage).toEqual([{ contractId: 'tasks', viewKey: 'all', revision: 1 }])
  })

  test('a command id coverage target names the id the view will echo', async () => {
    const d = db()
    const receipt = await runLocalCommand(
      d,
      { principalId: 'p1', commandId: 'cmd-1', commandName: 'x', arguments: {} },
      async () => ({
        status: 'acknowledged' as const,
        coverageViews: [],
        coverageCommandIds: [{ kind: 'command-id' as const, contractId: 'inbox', viewKey: 'all' }],
      }),
    )
    expect(receipt.coverage).toEqual([
      { kind: 'command-id', contractId: 'inbox', viewKey: 'all', commandId: 'cmd-1' },
    ])
  })

  test('a shared view advances the revision of the principal that owns it', async () => {
    const d = db()
    await runLocalCommand(
      d,
      { principalId: 'p1', commandId: 'cmd-1', commandName: 'x', arguments: {} },
      async () => ({
        status: 'acknowledged' as const,
        coverageViews: [{ contractId: 'team', viewKey: 'roster', revisionPrincipalId: 'owner1' }],
      }),
    )
    expect(await readViewRevision(d, 'owner1', 'team', 'roster')).toBe(1)
    expect(await readViewRevision(d, 'p1', 'team', 'roster')).toBe(0)
  })
})

describe('reading receipts back', () => {
  test('an unknown command id reads as null', async () => {
    expect(await readCommandReceipt(db(), 'p1', 'nope')).toBeNull()
  })

  test('a settled command is answered by id after a reload', async () => {
    const d = db()
    await runLocalCommand(
      d,
      { principalId: 'p1', commandId: 'cmd-1', commandName: 'x', arguments: {} },
      acknowledged({ ok: 1 }, []),
    )
    expect(await readCommandReceipt(d, 'p1', 'cmd-1')).toMatchObject({
      commandId: 'cmd-1', status: 'acknowledged', result: { ok: 1 },
    })
    // Another principal cannot read it.
    expect(await readCommandReceipt(d, 'p2', 'cmd-1')).toBeNull()
  })

  test('echoed ids list only acknowledged commands covering that view, newest first', async () => {
    const d = db()
    const run = (commandId: string, viewKey: string) =>
      runLocalCommand(
        d,
        { principalId: 'p1', commandId, commandName: 'x', arguments: { commandId } },
        acknowledged(null, [{ contractId: 'tasks', viewKey }]),
      )
    await run('c1', 'all')
    await run('c2', 'starred')
    await run('c3', 'all')
    await runLocalCommand(
      d,
      { principalId: 'p1', commandId: 'c4', commandName: 'x', arguments: {} },
      async () => ({ status: 'rejected' as const, code: 'NO', message: 'no' }),
    )
    expect(await echoedCommandIdsForView(d, 'p1', 'all')).toEqual(['c3', 'c1'])
    expect(await echoedCommandIdsForView(d, 'p1', 'all', { limit: 1 })).toEqual(['c3'])
  })
})
