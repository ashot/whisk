import {
  advanceViewRevision,
  type CommandIdCoverage,
  type CommandIdCoverageTarget,
  type CommandReceiptCoverage,
  type ViewCoverageTarget,
  type ViewRevisionConfig,
} from './viewRevisions'

/**
 * Durable command state for a local first client.
 *
 * A client mints a command id, applies the write optimistically, and sends it.
 * The server runs the command and receipts it in the SAME transaction, so the
 * id, the outcome and the view revisions it covers settle together. A client
 * that reloads mid flight asks for the receipt by id rather than reissuing the
 * command: the id is bound to one intent, so a repeat is answered, not rerun.
 *
 * Coverage is the reconciliation proof. A receipt names either the view
 * revisions that already include the write, or the views that will echo this
 * command id back. Either way the client can retire its optimistic copy on
 * evidence instead of on a timer.
 *
 * The receipt row keeps a hash of the arguments, never the arguments: receipts
 * are retained indefinitely and must not become a second copy of user content.
 */

export const LOCAL_COMMAND_RECEIPT_VERSION = 1

export type CommandErrorData = { code: string; message: string }

/** How a refusal reaches the client. Apps pass Convex's own error class. */
export type CommandErrorFactory = (data: CommandErrorData) => Error

const defaultError: CommandErrorFactory = (data) =>
  Object.assign(new Error(data.message), { data })

export type CommandStateConfig = {
  table?: string
  /** Index over (principal, command id). */
  principalCommandIndex?: string
  /** Index over (principal, creation order). */
  principalCreatedIndex?: string
  principalField?: string
  /** Where the covered view revisions live. */
  views?: ViewRevisionConfig
  /** Raise a refusal the client can branch on. */
  error?: CommandErrorFactory
  now?: () => number
}

const DEFAULTS = {
  table: 'local_command_receipts',
  principalCommandIndex: 'by_principal_command',
  principalCreatedIndex: 'by_principal_created',
  principalField: 'principal_id',
}

export type PublicCommandReceipt = {
  receiptVersion: number
  commandId: string
  commandName: string
  status: 'acknowledged' | 'rejected'
  result?: unknown
  rejection?: { code: string; message: string; correction?: unknown }
  coverage: CommandReceiptCoverage[]
  retryUntil: null
}

export type LocalCommandOutcome =
  | {
      status: 'acknowledged'
      result?: unknown
      /** Complete view contracts whose authoritative result includes the write. */
      coverageViews: readonly ViewCoverageTarget[]
      /** Views that prove reconciliation by echoing this exact command id. */
      coverageCommandIds?: readonly CommandIdCoverageTarget[]
    }
  | {
      status: 'rejected'
      code: string
      message: string
      correction?: unknown
    }

function isCommandIdCoverage(coverage: CommandReceiptCoverage): coverage is CommandIdCoverage {
  return 'kind' in coverage && coverage.kind === 'command-id'
}

/**
 * Canonicalize validated Convex arguments without relying on object insertion
 * order. The canonical value is hashed before persistence so indefinitely
 * retained dedupe receipts do not become a second copy of user content.
 */
export function canonicalCommandArguments(
  value: unknown,
  error: CommandErrorFactory = defaultError,
): string {
  const seen = new Set<object>()

  const encode = (input: unknown): string => {
    if (input === null) return 'null'
    if (typeof input === 'string') return JSON.stringify(input)
    if (typeof input === 'boolean') return input ? 'true' : 'false'
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) {
        throw error({ code: 'INVALID_COMMAND_ARGUMENTS', message: 'Command arguments must be finite' })
      }
      return Object.is(input, -0) ? '0' : String(input)
    }
    if (Array.isArray(input)) {
      if (seen.has(input)) {
        throw error({ code: 'INVALID_COMMAND_ARGUMENTS', message: 'Command arguments must not be cyclic' })
      }
      seen.add(input)
      const encoded = `[${input.map(encode).join(',')}]`
      seen.delete(input)
      return encoded
    }
    if (typeof input === 'object') {
      const object = input as Record<string, unknown>
      if (seen.has(object)) {
        throw error({ code: 'INVALID_COMMAND_ARGUMENTS', message: 'Command arguments must not be cyclic' })
      }
      seen.add(object)
      const entries = Object.keys(object)
        .sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${encode(object[key])}`)
      seen.delete(object)
      return `{${entries.join(',')}}`
    }
    throw error({
      code: 'INVALID_COMMAND_ARGUMENTS',
      message: `Unsupported command argument type: ${typeof input}`,
    })
  }

  return encode(value)
}

/** Cryptographically bind a command id to intent without retaining its payload. */
export async function commandArgumentsFingerprint(
  value: unknown,
  error: CommandErrorFactory = defaultError,
): Promise<string> {
  const canonical = canonicalCommandArguments(value, error)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')).join('')
  return `sha256:${hex}`
}

export function validateCommandId(value: string, error: CommandErrorFactory = defaultError): string {
  if (!value || value !== value.trim()) {
    throw error({
      code: 'INVALID_COMMAND_ID',
      message: 'commandId must be a non-empty canonical string',
    })
  }
  if (value.length > 160) {
    throw error({ code: 'INVALID_COMMAND_ID', message: 'commandId is too long' })
  }
  return value
}

function toPublicReceipt(receipt: any): PublicCommandReceipt {
  return {
    receiptVersion: receipt.receipt_version,
    commandId: receipt.command_id,
    commandName: receipt.command_name,
    status: receipt.status,
    ...(receipt.status === 'acknowledged' && receipt.result !== undefined
      ? { result: receipt.result }
      : {}),
    ...(receipt.status === 'rejected'
      ? {
          rejection: {
            code: receipt.rejection_code,
            message: receipt.rejection_message,
            ...(receipt.correction !== undefined ? { correction: receipt.correction } : {}),
          },
        }
      : {}),
    coverage: receipt.coverage.map((item: any) => item.kind === 'command-id'
      ? {
          kind: 'command-id' as const,
          contractId: item.contract_id,
          viewKey: item.view_key,
          commandId: item.command_id,
        }
      : {
          contractId: item.contract_id,
          viewKey: item.view_key,
          revision: item.revision,
        }),
    // The initial protocol retains dedupe receipts indefinitely.
    retryUntil: null,
  }
}

function receiptByCommand(
  db: any,
  principalId: unknown,
  commandId: string,
  config: CommandStateConfig,
) {
  return db
    .query(config.table ?? DEFAULTS.table)
    .withIndex(config.principalCommandIndex ?? DEFAULTS.principalCommandIndex, (q: any) =>
      q.eq(config.principalField ?? DEFAULTS.principalField, principalId).eq('command_id', commandId))
    .unique()
}

/** Resolve an ambiguous client transport attempt without reissuing new intent. */
export async function readCommandReceipt(
  db: any,
  principalId: unknown,
  commandId: string,
  config: CommandStateConfig = {},
): Promise<PublicCommandReceipt | null> {
  const id = validateCommandId(commandId, config.error ?? defaultError)
  const receipt = await receiptByCommand(db, principalId, id, config)
  return receipt ? toPublicReceipt(receipt) : null
}

/**
 * The caller's recently receipted command ids whose coverage names `viewKey`,
 * read inside the SAME query snapshot as the view result that embeds them —
 * which is what makes the echo a sound write reconciliation proof: an id listed
 * in a granted envelope proves that result includes the command's write.
 *
 * Bounded window: `scan` recent receipts are examined, `limit` ids returned. A
 * command can outrun the window only if the caller receipts `scan` newer
 * commands before ANY refire of this view reaches them — pathological for human
 * rate slices.
 */
export async function echoedCommandIdsForView(
  db: any,
  principalId: unknown,
  viewKey: string,
  options: { scan?: number; limit?: number } = {},
  config: CommandStateConfig = {},
): Promise<string[]> {
  const scan = options.scan ?? 200
  const limit = options.limit ?? 64
  const recent = await db
    .query(config.table ?? DEFAULTS.table)
    .withIndex(config.principalCreatedIndex ?? DEFAULTS.principalCreatedIndex, (q: any) =>
      q.eq(config.principalField ?? DEFAULTS.principalField, principalId))
    .order('desc')
    .take(scan)
  const ids: string[] = []
  for (const receipt of recent) {
    if (receipt.status !== 'acknowledged') continue
    if (!receipt.coverage.some((entry: any) => entry.view_key === viewKey)) continue
    ids.push(receipt.command_id)
    if (ids.length >= limit) break
  }
  return ids
}

/**
 * Execute and receipt one validated command in a single Convex transaction.
 * Known domain refusals are returned by `execute` as `rejected`; unexpected
 * exceptions abort the transaction and intentionally do not manufacture a
 * terminal receipt.
 */
export async function runLocalCommand<Result>(
  db: any,
  input: {
    principalId: unknown
    commandId: string
    commandName: string
    arguments: unknown
  },
  execute: () => Promise<LocalCommandOutcome & { result?: Result }>,
  config: CommandStateConfig = {},
): Promise<PublicCommandReceipt> {
  const error = config.error ?? defaultError
  const principalField = config.principalField ?? DEFAULTS.principalField
  const commandId = validateCommandId(input.commandId, error)
  const argumentFingerprint = await commandArgumentsFingerprint(input.arguments, error)
  const existing = await receiptByCommand(db, input.principalId, commandId, config)

  if (existing) {
    if (
      existing.command_name !== input.commandName ||
      existing.argument_fingerprint !== argumentFingerprint
    ) {
      throw error({
        code: 'COMMAND_ID_REUSED',
        message: 'This command id is already bound to different intent',
      })
    }
    return toPublicReceipt(existing)
  }

  const outcome = await execute()
  const coverage: CommandReceiptCoverage[] = []
  if (outcome.status === 'acknowledged') {
    const views = [...new Map(
      outcome.coverageViews.map((target) => [
        `${target.revisionPrincipalId ?? input.principalId}\0${target.contractId}\0${target.viewKey}`,
        target,
      ]),
    ).values()].sort((a, b) =>
      a.contractId.localeCompare(b.contractId) || a.viewKey.localeCompare(b.viewKey))
    for (const target of views) {
      coverage.push(await advanceViewRevision(
        db,
        target.revisionPrincipalId ?? input.principalId,
        target.contractId,
        target.viewKey,
        config.views,
      ))
    }
    const commandIdTargets = [...new Map(
      (outcome.coverageCommandIds ?? []).map((target) => [
        `${target.contractId}\0${target.viewKey}`,
        target,
      ]),
    ).values()].sort((a, b) =>
      a.contractId.localeCompare(b.contractId) || a.viewKey.localeCompare(b.viewKey))
    for (const target of commandIdTargets) {
      coverage.push({
        kind: 'command-id',
        contractId: target.contractId,
        viewKey: target.viewKey,
        commandId,
      })
    }
  }

  const stored = {
    [principalField]: input.principalId,
    command_id: commandId,
    command_name: input.commandName,
    receipt_version: LOCAL_COMMAND_RECEIPT_VERSION,
    argument_fingerprint: argumentFingerprint,
    status: outcome.status,
    ...(outcome.status === 'acknowledged' && outcome.result !== undefined
      ? { result: outcome.result }
      : {}),
    ...(outcome.status === 'rejected'
      ? {
          rejection_code: outcome.code,
          rejection_message: outcome.message,
          ...(outcome.correction !== undefined ? { correction: outcome.correction } : {}),
        }
      : {}),
    coverage: coverage.map((item) => isCommandIdCoverage(item)
      ? {
          kind: 'command-id' as const,
          contract_id: item.contractId,
          view_key: item.viewKey,
          command_id: item.commandId,
        }
      : {
          contract_id: item.contractId,
          view_key: item.viewKey,
          revision: item.revision,
        }),
    created_at: (config.now ?? Date.now)(),
  }
  await db.insert(config.table ?? DEFAULTS.table, stored)
  return toPublicReceipt(stored)
}
