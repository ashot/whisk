import { applyPatches, sideEffectPayload } from './patches'
import {
  acknowledgedReceipt,
  beginReceipt,
  finishReceipt,
  receiptActionEnvelope,
  type ReceiptConfig,
} from './receipts'
import type { EngineCtx, InsertedRows, TableConfig } from './types'

/**
 * A named server consequence of a client action. It runs after the patch pass,
 * so `inserted` already holds the rows that pass created.
 */
export type SideEffect<Actor> = (
  ctx: any,
  actor: Actor,
  payload: any,
  clientResult: unknown,
  inserted: InsertedRows,
) => Promise<unknown>

/** The argument shape the rail declares. */
export type DispatchArgs = {
  token: string
  action: string
  args?: unknown
  patches?: unknown
  result?: unknown
  /**
   * Optional. A receipt-aware action already carries its command id in the
   * envelope inside `result`, and the rail reads it there; this field only
   * covers a caller that names the id without sending an envelope.
   */
  commandId?: string
}

export type CreateDispatchOptions<Actor, Mutation = unknown> = {
  /**
   * The app's generated `mutation` builder.
   *
   * Prefer `createDispatchDefinition` and call the builder yourself:
   * `export const dispatch = mutation(createDispatchDefinition({...}))`.
   * Convex's builder is generic over its own args validator, so handing it
   * through an injected function loses that inference and every caller's
   * payload falls back to `Record<string, unknown>` — the rail stops
   * typechecking client mutations. Calling the builder at the app keeps it.
   */
  mutation: (def: any) => Mutation
  /** The app's `convex/values` validator namespace. */
  v: any
  /** The client-writable allowlist. */
  tables: Record<string, TableConfig>
  sideEffects: Record<string, SideEffect<Actor>>
  /**
   * Auth resolution, which stays in the app: turn a token into the actor the
   * side effects receive plus the owner id every write is scoped to.
   *
   * `ownerId` may be a thunk. Any function value is treated as one — resolved
   * lazily, at most once, and only when a write actually needs the owner (a
   * patch pass, or a receipt). A dispatch that carries neither never invokes
   * it, so a resolver with side effects of its own (whisk's user backfill
   * writes rows) stays untriggered on side-effect-only traffic.
   */
  resolveActor: (
    ctx: any,
    token: string,
  ) => Promise<{ actor: Actor; ownerId: unknown | (() => Promise<unknown>) }>
  /** Enables command receipt dedupe when set. */
  receipts?: ReceiptConfig
  /** Second scope column carried onto inserted rows (aurora's `child_id`). */
  scopeField?: string
  /** Proves a payload scope belongs to the owner before a create lands under it. */
  scopeOwned?: (ctx: any, scopeId: unknown, ownerId: unknown) => Promise<boolean>
  now?: () => number
}

/**
 * The one write rail.
 *
 * A client store action produces (a) generic field patches for tables the
 * client is allowed to own, and (b) a named side effect for anything needing
 * server logic. Both arrive in one mutation so an optimistic UI write and its
 * server consequence can never half-apply.
 *
 * The table allowlist is the security boundary: anything not listed can only
 * be changed by a server-side tool or action.
 */
export function createDispatch<Actor, Mutation = unknown>(
  options: CreateDispatchOptions<Actor, Mutation>,
): Mutation {
  return options.mutation(createDispatchDefinition(options))
}

/**
 * The rail as a plain Convex definition: `{ args, handler }`, ready for the
 * app's own builder. This is the form to use — see the `mutation` option.
 */
export function createDispatchDefinition<Actor>(
  options: Omit<CreateDispatchOptions<Actor, unknown>, 'mutation'>,
) {
  const { v, tables, sideEffects, resolveActor, receipts, scopeField, scopeOwned } = options
  const now = options.now ?? Date.now

  return {
    args: {
      token: v.string(),
      action: v.string(),
      args: v.optional(v.any()),
      patches: v.optional(v.any()),
      result: v.optional(v.any()),
      ...(receipts ? { commandId: v.optional(v.string()) } : {}),
    },
    handler: async (
      ctx: EngineCtx,
      {
        token,
        action,
        args: actionArgs,
        patches,
        result,
        commandId,
      }: {
        token: string
        action: string
        args?: unknown
        patches?: unknown
        result?: unknown
        commandId?: string
      },
    ) => {
      // A receipt-aware action carries its command id inside `result`. Read it
      // from there rather than trusting the client transport to have lifted it
      // into the argument above: every client packs the envelope, but each one
      // would otherwise have to remember the extra field, and one that forgets
      // loses dedupe silently. The envelope also names the id the client will
      // check the answer against, so it is the id to dedupe under. The
      // argument covers a caller that sends no envelope at all.
      const envelope = receiptActionEnvelope(result)
      const command = envelope?.commandId ?? commandId
      // The action's own return value sits inside the envelope. Side effects
      // read the value, never the wrapper.
      const clientResult = envelope ? envelope.localResult ?? null : result

      const { actor, ownerId } = await resolveActor(ctx, token)

      // Memoized so the receipt sites and the patch pass share one
      // resolution: a thunk that writes must not run three times per
      // dispatch, and must not run at all when nothing below calls this.
      let ownerOnce: Promise<unknown> | null = null
      const owner = () =>
        typeof ownerId === 'function'
          ? (ownerOnce ??= (ownerId as () => Promise<unknown>)())
          : Promise.resolve(ownerId)

      // Receipt dedupe: a command that already ran returns its stored result
      // rather than running twice — this is what lets a client promise
      // survive a reload.
      if (receipts && command) {
        const replay = await beginReceipt(ctx, receipts, await owner(), command, now)
        if (replay) {
          return envelope
            ? acknowledgedReceipt(envelope.commandId, replay.result)
            : replay.result
        }
      }

      // Deliberately outside the try below: a failed patch pass leaves the
      // receipt claimed and propagates, rather than settling as a clean error.
      let inserted: InsertedRows = {}
      if (patches && typeof patches === 'object') {
        inserted = await applyPatches(
          ctx,
          tables,
          await owner(),
          patches as any,
          { scopeField, now, actor, scopeOwned },
        )
      }

      let out: unknown = null
      try {
        const sideEffect = sideEffects[action]
        if (sideEffect) {
          out = await sideEffect(ctx, actor, sideEffectPayload(actionArgs), clientResult, inserted)
        }
      } catch (err) {
        if (receipts && command) {
          await finishReceipt(ctx, receipts, await owner(), command, 'error', null, String(err), now)
        }
        throw err
      }

      if (receipts && command) {
        await finishReceipt(ctx, receipts, await owner(), command, 'done', out, undefined, now)
      }
      // A receipt-aware client waits for the receipt shape, not the bare
      // result: it matches the command id before it trusts the answer. Every
      // other dispatch keeps returning exactly what the side effect returned.
      return envelope ? acknowledgedReceipt(envelope.commandId, out) : out
    },
  }
}
