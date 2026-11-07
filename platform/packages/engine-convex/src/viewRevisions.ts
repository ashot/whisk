/**
 * Per view revision counters.
 *
 * A view is one named result a client renders — a contract id plus a view key.
 * Its revision is bumped inside the domain mutation's own transaction, so a
 * command receipt can name the exact revision that already includes the write.
 * The client compares the revision it holds against the one the receipt covers
 * and knows, without a round trip, whether its copy is current.
 *
 * The counters are per principal: the same view key under two users is two
 * independent revisions.
 */

export type ViewCoverage = {
  contractId: string
  viewKey: string
  revision: number
}

export type CommandIdCoverageTarget = {
  kind: 'command-id'
  contractId: string
  viewKey: string
}

export type CommandIdCoverage = CommandIdCoverageTarget & {
  commandId: string
}

export type CommandReceiptCoverage = ViewCoverage | CommandIdCoverage

export type ViewCoverageTarget = Pick<ViewCoverage, 'contractId' | 'viewKey'> & {
  /**
   * Revision domain owner when the caller is one authorized viewer of a shared
   * view. This identity is server derived and never appears in public receipts.
   */
  revisionPrincipalId?: unknown
}

/** Where the revision heads live, and what their columns are called. */
export type ViewRevisionConfig = {
  table?: string
  /** Index over (principal, contract, view key). */
  index?: string
  principalField?: string
  contractField?: string
  viewField?: string
  now?: () => number
}

const DEFAULTS = {
  table: 'local_view_heads',
  index: 'by_principal_contract_view',
  principalField: 'principal_id',
  contractField: 'contract_id',
  viewField: 'view_key',
}

function headQuery(
  db: any,
  principalId: unknown,
  contractId: string,
  viewKey: string,
  config: ViewRevisionConfig,
) {
  return db
    .query(config.table ?? DEFAULTS.table)
    .withIndex(config.index ?? DEFAULTS.index, (q: any) =>
      q
        .eq(config.principalField ?? DEFAULTS.principalField, principalId)
        .eq(config.contractField ?? DEFAULTS.contractField, contractId)
        .eq(config.viewField ?? DEFAULTS.viewField, viewKey))
    .unique()
}

/** The revision a principal's view is currently at. Zero when never written. */
export async function readViewRevision(
  db: any,
  principalId: unknown,
  contractId: string,
  viewKey: string,
  config: ViewRevisionConfig = {},
): Promise<number> {
  const head = await headQuery(db, principalId, contractId, viewKey, config)
  return head?.revision ?? 0
}

/** Advance a view revision inside the domain mutation's Convex transaction. */
export async function advanceViewRevision(
  db: any,
  principalId: unknown,
  contractId: string,
  viewKey: string,
  config: ViewRevisionConfig = {},
): Promise<ViewCoverage> {
  const current = await headQuery(db, principalId, contractId, viewKey, config)
  const revision = (current?.revision ?? 0) + 1
  const updatedAt = (config.now ?? Date.now)()
  if (current) {
    await db.patch(current._id, { revision, updated_at: updatedAt })
  } else {
    await db.insert(config.table ?? DEFAULTS.table, {
      [config.principalField ?? DEFAULTS.principalField]: principalId,
      [config.contractField ?? DEFAULTS.contractField]: contractId,
      [config.viewField ?? DEFAULTS.viewField]: viewKey,
      revision,
      updated_at: updatedAt,
    })
  }
  return { contractId, viewKey, revision }
}
