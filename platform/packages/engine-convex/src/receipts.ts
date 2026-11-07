import type { EngineCtx } from './types'

export type ReceiptStatus = 'running' | 'done' | 'error'

export type ReceiptConfig = {
  /** Table holding receipts. */
  table: string
  /** Index over (owner, command id). */
  index: string
  ownerField?: string
  commandField?: string
}

const DEFAULTS = { ownerField: 'account_id', commandField: 'command_id' }

/**
 * What a receipt-aware client action sends as its `result`.
 *
 * The client middleware mints the command id, packs it here, and journals the
 * whole envelope in its durable outbox. So the envelope — not a separate
 * argument the app wiring has to remember — is where the command id reliably
 * is, on the first send and on every later replay of that journalled row.
 */
export type ReceiptActionEnvelope = {
  receiptActionVersion: 1
  commandId: string
  localResult?: unknown
}

/** The envelope when `result` is one, else null. */
export function receiptActionEnvelope(result: unknown): ReceiptActionEnvelope | null {
  const envelope = result as Partial<ReceiptActionEnvelope> | null
  return envelope &&
    typeof envelope === 'object' &&
    envelope.receiptActionVersion === 1 &&
    typeof envelope.commandId === 'string' &&
    envelope.commandId.length > 0
    ? (envelope as ReceiptActionEnvelope)
    : null
}

/** What a receipt-aware client waits for: the command id it sent, and the answer. */
export type CommandReceiptResponse = {
  commandId: string
  status: 'acknowledged'
  result: unknown
}

export function acknowledgedReceipt(
  commandId: string,
  result: unknown,
): CommandReceiptResponse {
  return { commandId, status: 'acknowledged', result: result ?? null }
}

function findReceipt(ctx: EngineCtx, config: ReceiptConfig, ownerId: unknown, commandId: string) {
  const ownerField = config.ownerField ?? DEFAULTS.ownerField
  const commandField = config.commandField ?? DEFAULTS.commandField
  return ctx.db
    .query(config.table as any)
    .withIndex(config.index as any, (q: any) =>
      q.eq(ownerField, ownerId).eq(commandField, commandId),
    )
    .unique()
}

/** A settled receipt replayed instead of running the command again. */
export type ReceiptReplay = { replay: true; result: unknown }

/**
 * Claim a command id before running it.
 *
 * Returns a replay when the command already settled — this is what lets a
 * client promise survive a reload: the same command id returns the same
 * answer rather than running twice. A receipt still `running` falls through
 * and runs again, because a half-applied command is worse than a repeated one.
 */
export async function beginReceipt(
  ctx: EngineCtx,
  config: ReceiptConfig,
  ownerId: unknown,
  commandId: string,
  now: () => number = Date.now,
): Promise<ReceiptReplay | null> {
  const ownerField = config.ownerField ?? DEFAULTS.ownerField
  const commandField = config.commandField ?? DEFAULTS.commandField
  const existing: any = await findReceipt(ctx, config, ownerId, commandId)

  if (existing && existing.status !== 'running') {
    if (existing.status === 'error') throw new Error(existing.error ?? 'command failed')
    return { replay: true, result: existing.result ?? null }
  }
  if (!existing) {
    const at = now()
    await ctx.db.insert(config.table as any, {
      [ownerField]: ownerId,
      [commandField]: commandId,
      status: 'running',
      created_at: at,
      updated_at: at,
    } as any)
  }
  return null
}

/** Settle a claimed receipt with its result or its error. */
export async function finishReceipt(
  ctx: EngineCtx,
  config: ReceiptConfig,
  ownerId: unknown,
  commandId: string,
  status: 'done' | 'error',
  result: unknown,
  error: string | undefined,
  now: () => number = Date.now,
): Promise<void> {
  const row: any = await findReceipt(ctx, config, ownerId, commandId)
  if (row) {
    await ctx.db.patch(row._id, { status, result, error, updated_at: now() } as any)
  }
}
