/**
 * Per owner sync cursors: how far a named stream has been read.
 *
 * This is the resumable position an ingesting client keeps for each source it
 * tails — a log file, a mailbox, a folder. One row per (owner, key), read and
 * written by key, so a client that restarts continues where it stopped instead
 * of replaying the source.
 *
 * The cursor set of one owner is small (one row per source), so the read is an
 * indexed collect on the owner and a lookup by key in memory. Auth stays in the
 * app: the definitions below take a resolver and refuse any owner but the one
 * it returns.
 */

export type SyncCursorConfig = {
  table?: string
  /** Index over the owner column. */
  ownerIndex?: string
  ownerField?: string
  /** Column naming the stream this cursor belongs to. */
  keyField?: string
  /** Column holding the position reached. */
  positionField?: string
  /** Column stamped on every write. */
  updatedField?: string
  now?: () => number
}

const DEFAULTS = {
  table: 'sync_cursors',
  ownerIndex: 'by_user_id',
  ownerField: 'user_id',
  keyField: 'file_path_hash',
  positionField: 'last_position',
  updatedField: 'last_synced_at',
}

async function cursorsOf(db: any, ownerId: unknown, config: SyncCursorConfig): Promise<any[]> {
  return db
    .query(config.table ?? DEFAULTS.table)
    .withIndex(config.ownerIndex ?? DEFAULTS.ownerIndex, (q: any) =>
      q.eq(config.ownerField ?? DEFAULTS.ownerField, ownerId))
    .collect()
}

/** Move one stream's cursor, creating the row on first sight. */
export async function writeSyncCursor(
  db: any,
  ownerId: unknown,
  key: string,
  position: number,
  config: SyncCursorConfig = {},
): Promise<any> {
  const keyField = config.keyField ?? DEFAULTS.keyField
  const positionField = config.positionField ?? DEFAULTS.positionField
  const updatedField = config.updatedField ?? DEFAULTS.updatedField
  const cursors = await cursorsOf(db, ownerId, config)
  const cursor = cursors.find((c) => c[keyField] === key)
  const now = (config.now ?? Date.now)()
  if (cursor) {
    await db.patch(cursor._id, { [positionField]: position, [updatedField]: now })
    return cursor._id
  }
  return db.insert(config.table ?? DEFAULTS.table, {
    [config.ownerField ?? DEFAULTS.ownerField]: ownerId,
    [keyField]: key,
    [positionField]: position,
    [updatedField]: now,
  })
}

/** One stream's position, or null when the owner has never read it. */
export async function readSyncCursor(
  db: any,
  ownerId: unknown,
  key: string,
  config: SyncCursorConfig = {},
): Promise<number | null> {
  const keyField = config.keyField ?? DEFAULTS.keyField
  const cursors = await cursorsOf(db, ownerId, config)
  const cursor = cursors.find((c) => c[keyField] === key)
  if (!cursor) return null
  return cursor[config.positionField ?? DEFAULTS.positionField]
}

/** Drop every cursor an owner holds, so the next read starts from the top. */
export async function clearSyncCursors(
  db: any,
  ownerId: unknown,
  config: SyncCursorConfig = {},
): Promise<{ deleted: number }> {
  const cursors = await cursorsOf(db, ownerId, config)
  for (const cursor of cursors) {
    await db.delete(cursor._id)
  }
  return { deleted: cursors.length }
}

export type SyncCursorOptions = {
  /** The app's `convex/values` validator namespace. */
  v: any
  /** Validator for the owner argument, so the app keeps its id typing. */
  ownerValidator?: any
  /**
   * Auth resolution, which stays in the app. It receives the ctx and the
   * optional token argument and returns the caller, or null. `write` is called
   * for the mutations and `read` for the query, so an app can hold a read only
   * token to a lower bar.
   */
  resolveOwner: {
    write: (ctx: any, token?: string) => Promise<unknown | null>
    read?: (ctx: any, token?: string) => Promise<unknown | null>
  }
  config?: SyncCursorConfig
}

/**
 * The three cursor endpoints as plain Convex definitions, ready for the app's
 * own builders. A caller may only touch its own cursors: the resolved owner
 * must equal the owner named in the arguments.
 */
export function createSyncCursorDefinitions(options: SyncCursorOptions) {
  const { v, resolveOwner, config } = options
  const ownerArg = options.ownerValidator ?? v.string()
  const ownerField = config?.ownerField ?? DEFAULTS.ownerField
  const keyField = config?.keyField ?? DEFAULTS.keyField
  const positionField = config?.positionField ?? DEFAULTS.positionField
  const readOwner = resolveOwner.read ?? resolveOwner.write

  const sameOwner = (resolved: unknown, claimed: unknown) =>
    !!resolved && String(resolved) === String(claimed)

  return {
    update: {
      args: {
        [ownerField]: ownerArg,
        [keyField]: v.string(),
        [positionField]: v.number(),
        api_token: v.optional(v.string()),
      },
      handler: async (ctx: any, args: any) => {
        const owner = await resolveOwner.write(ctx, args.api_token)
        if (!sameOwner(owner, args[ownerField])) {
          throw new Error('Authentication failed: invalid token or session')
        }
        return writeSyncCursor(ctx.db, args[ownerField], args[keyField], args[positionField], config)
      },
    },

    clear: {
      args: {
        [ownerField]: ownerArg,
        api_token: v.optional(v.string()),
      },
      handler: async (ctx: any, args: any) => {
        const owner = await resolveOwner.write(ctx, args.api_token)
        if (!sameOwner(owner, args[ownerField])) throw new Error('Authentication failed')
        return clearSyncCursors(ctx.db, args[ownerField], config)
      },
    },

    read: {
      args: {
        [ownerField]: ownerArg,
        [keyField]: v.string(),
        api_token: v.optional(v.string()),
      },
      handler: async (ctx: any, args: any) => {
        const owner = await readOwner(ctx, args.api_token)
        if (!sameOwner(owner, args[ownerField])) return null
        return readSyncCursor(ctx.db, args[ownerField], args[keyField], config)
      },
    },
  }
}
