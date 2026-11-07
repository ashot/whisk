# @platform/engine-convex

The server half of the local-first engine: the write rail and delta paging a Convex backend needs to serve `@platform/engine` clients. Extracted from the whisk/aurora pair, shaped for codecast parity.

## What it exports

- `createDispatch(options)` — the one write mutation. A client action arrives as generic field patches plus an optional named side effect; both apply in one transaction. The app supplies its `mutation` builder (the return type is generic, so the export keeps the app's registered mutation type and survives Convex's api filtering), its table allowlist, side effect handlers, and `resolveActor`. `ownerId` may be a thunk: it resolves lazily, at most once, and never on a side-effect-only dispatch.
- `applyPatches(ctx, tables, ownerId, patches, opts)` — patch application over the table config. The allowlist is the security boundary: declared fields, immutable fields, an optional `overflowField`, singleton kinds with their lookup index.
- `TableConfig.beforePatch?(doc, safe)` — optional per-table rewrite of an incoming patch after the allowlist checks and before it lands (update receives the existing doc, insert receives null). Exists for codecast parity; whisk and aurora pass no hook and are unaffected.
- `deltaPage(...)` — watermark paging that returns `{ rows, nextSince, hasMore }` and never advances the watermark past a timestamp that was not fully drained. Writes in one transaction share a timestamp; a page boundary landing inside such a group must not skip the rest of the group.
- `beginReceipt` / `finishReceipt` — command receipt dedupe, so a client promise survives a reload.
- `singleton`, `collection`, `sideEffectPayload`, `isConvexId` and the supporting types.

## The sync spine

The write rail above tells a client that its own write landed. The spine tells a client what happened while it was away. It is the second half of the same engine, extracted from codecast.

- `makeChangeTrackedDb(rawDb, { changeLog, syncLog }, collector?)` — the emission side. It wraps a Convex `DatabaseWriter` so every insert, patch, replace and delete to a tracked table also records that the entity changed. The change log keeps ONE row per entity, keyed by entity id, and bumps its `seq` on each write, so the table is bounded by entity count rather than change volume: a conversation touched on every message batch updates a single row in place.
- `createTrackedBuilders({ mutation, internalMutation, tracking, wrappers })` — the write interceptor. It returns drop in replacements for the app's generated builders, so completeness comes from one interception point: any mutation built from here emits, no matter how it writes. Pair it with a source level test that fails the build when a file writing a tracked table imports the raw builders instead.
- `readChangesSince(ctx, { userId, teamIds, since, limit })` and `mergeChangeFeed(sources, since)` — the read side. It returns the set of entity ids that changed in any scope the caller can see, and a cursor the client advances itself. The merge is gap free: when any scope filled its window, the cursor stops at the LOWEST such scope's last fetched `seq`, because past that point another scope has rows nobody has read.
- `appendSyncAction` / `emitSyncActions` / `readRangePage` / `readSyncHeads` — the ordered per scope log that supersedes the change log's wall clock cursor. Positions come from reading and bumping the scope's head row inside the same transaction as the domain write, so they are strictly increasing in commit order. That, and nothing about a clock, is the ordering proof. An entity's active row is MOVED to the new head rather than appended again, which bounds this table too.
- `pruneScope` / `prunablePrefix` — retention as a per scope prefix walk. A drained scope raises its floor to its head, so a client returning after the window is told to resync instead of reading an empty range as caught up. The scheduled chain that calls this stays in the app.
- `writeSyncCursor` / `readSyncCursor` / `clearSyncCursors` and `createSyncCursorDefinitions` — per owner positions for a stream a client tails, so an ingesting client resumes instead of replaying.
- `advanceViewRevision` / `readViewRevision` — per view revision counters, bumped inside the domain mutation's own transaction.
- `runLocalCommand` / `readCommandReceipt` / `echoedCommandIdsForView` — durable command state. A command id is bound to one intent, so a repeat is answered rather than rerun, and the receipt names the view revisions that already include the write. The row stores a hash of the arguments, never the arguments.

### The configuration surface

The mechanism is the library's; the catalog is the app's. Nothing here imports an app schema, and `convex/server` and `convex/values` stay peer imports.

An app supplies:

- `changeLog.trackedTables` — the tables whose writes feed the log. A table qualifies when its rows carry the uniform scope shape every catch up query relies on.
- `changeLog.scopeFields` (or `scopeFromDoc`) — the columns a row's owner and team are read off. The default pair is `user_id` and `team_id`.
- `changeLog.entityType` — how a table names the entity type recorded on the row. Defaults to the table name.
- `changeLog.membership` — the table whose writes announce a scope the user joined or left.
- `syncLog.ownerOnlyEntities` — the entity types a team scope never carries. Codecast lists conversations: the inbox is mine, and a teammate seeing my session in the team feed is a separate axis with its own cursor.
- `syncLog.churnOnlyFields` — the counters and liveness stamps that may change without emitting an action. Without this exemption every message flush would contend on the owner's single head row and wake every online client.
- Table and index names on every config, so an app keeps its own schema vocabulary.
- Its generated `mutation` and `internalMutation` builders, its `v` validator namespace, and the auth resolvers the definition factories call. Auth never moves into the library.

### Change feed or plain delta paging

Delta paging asks one table what changed after a watermark, so a client needs one cursor per table and every write it cares about must bump that table's watermark. That is enough while the surface is a handful of tables and every meaningful write touches `updated_at`. The change feed is what an app needs when neither holds: when a client renders many entity types at once and walking a cursor per table costs a round trip per table, or when writes that matter do not move the row's own watermark — a dismiss stamp, a membership change, a delete. A delete is the clearest case, because a deleted row has no watermark left to read. Reach for the feed when a client returning after an hour offline has to learn about several kinds of entity in one question; keep plain delta paging when one table's watermark already answers it.

## Consumers

- whisk: `packages/convex/convex/dispatch.ts` and `sync.ts`
- aurora: `packages/convex/convex/dispatch.ts` and `sync.ts`
- codecast: pending (ct-44853). `beforePatch` and the generic mutation typing exist so that adoption drops nothing, and the sync spine above is codecast's own, parameterized.

`convex/server` and `convex/values` are peer imports; this package never imports an app schema. Tests: `bun test` in this directory.
