# packages/platform — local-first engine (ported from codecast)

The platform package is a faithful port of codecast's local-first store engine, with every
codecast-specific assumption turned into injected configuration. Source files live in
`~/src/codecast/packages/web/store/`. Port fidelity matters: these files encode years of
hard-won fixes (identity reuse, pending protection, outbox races). Copy logic verbatim
wherever possible; only the seams listed below change.

## Package layout

```
packages/platform/
  package.json          name "@mail/platform"; deps: mutative, zustand, dexie; peer: react
  tsconfig.json         extends ../../tsconfig.base.json
  src/
    index.ts            public exports
    types.ts            PlatformConfig, RegistryEntry, SyncOpts, PendingEntry, OutboxEntry
    registry.ts         derives maps from an injected registry (port of clientSyncRegistry.ts
                        minus the codecast entries — the REGISTRY ITSELF is app-supplied)
    middleware.ts       port of mutativeMiddleware.ts
    syncProtocol.ts     port of syncProtocol.ts
    syncEngine.ts       generic syncTable/syncRecord/applyMerge recipes (extracted from
                        inboxStore.ts lines ~5488-5700 + applyMerge)
    idbCache.ts         port of idbCache.ts — Dexie schema DERIVED from registry
    idbCollectionDiff.ts port verbatim
    wakeSig.ts          port verbatim
    undoStack.ts        port verbatim (generic already)
    react.ts            useTrackedStore factory + useCoarseNow (ported)
```

## The config seam

```ts
export type PlatformConfig = {
  dbName: string;                       // "mail-store"
  dbVersion: number;
  registry: Record<string, RegistryEntry>;   // same shape as codecast ClientSyncRegistryEntry
  syncRegistry: Record<string, SyncOpts>;    // same shape as codecast SYNC_REGISTRY
  // syncProtocol: fields where server-omitted and local-null mean the same ack
  optionalClearFields?: Set<string>;
  // middleware policy (codecast hardcodes these):
  mustDeliverActions?: Set<string>;
  outboxCoalesceKeys?: Record<string, (args: any[]) => string | null>;
  transformReplayPatches?: (patches: any) => any;   // codecast: stripStalePointerFromReplay
  // view-motion guard (codecast: currentSessionId/pendingNavigateId + viewNav):
  viewGuard?: {
    fields: string[];
    audit: (changes: {field: string; from: any; to: any}[], actionName: string) => string[];
  };
  // receipt continuations (codecast: navigate/assignBucket) — mail passes none initially:
  receiptContinuations?: { ... resolve/apply hooks ... };
  // generateAutoPending ack-stamp fields (codecast: inbox_dismissed_at/stashed_at):
  hideAckFields?: Set<string>;
  // id shape for "real server row" (codecast: 32-char base32 convex id):
  isServerId?: (id: string) => boolean;   // default: /^[a-z0-9]{32}$/
  detailTables?: Record<string, { keyField: string }>;  // e.g. threadMessages keyed by threadId
};
```

`createLocalFirstStore(config, storeCreator)` wires middleware + registry and returns the
zustand store plus `{ action, sync, asyncAction, receiptAsyncAction }` decorators and a
`useTrackedStore` bound to the store type. IDB wiring (`_setIDBWrite`, `_setOutbox`) and
hydration boot are provided by `createPersistence(config, store)` — port the hydration
logic (critical/deferred phases, merge strategies shape/fill, manual keys) from
inboxStore's boot block; find it by searching `HYDRATION_CRITICAL_KEYS` in
`packages/web/store/inboxStore.ts`.

## What stays byte-identical (do not "improve")

- applySyncTable / applySyncRecord — including copy-on-write pending, the single-pass
  pending partition, scalar identity reuse, whole-collection identity reuse, delta
  semantics, pruneAbsentScope, preserveFields.
- The middleware action wrapper: patch capture, generateAutoPending, parallel
  dispatch+enqueue, retireOutboxEntry race handling, drainOutbox (coalesce across
  reloads, boot-attempt caps, must-deliver, receipt handling), storage watchdog,
  monotonic outbox timestamps.
- syncEngine collection recipe: altKey stub rekey + pending rekey + field-override
  reapply, keepSelected, updated_at short-circuit, identity-reuse commit skips.
  The codecast-specific inline blocks (session continuations, bucketAssignments
  post-create clearing) are DROPPED — that behavior belongs to app registry
  transforms, not the engine. rekeyId becomes a config hook: `rekeyExtra?(draft, oldId,
  newId)` so apps can rekey their own referencing state.
- wakeSig, idbCollectionDiff, undoStack: verbatim.

## What is dropped (codecast residue, not generalized)

- viewNav.ts itself (the guard hook seam remains; mail supplies a simple audit or none).
- Session/bucket/comment/receipt-continuation specifics; LEGACY_RECEIPT_ACTIONS becomes
  config (default empty).
- The `dismissedSessions`→v5 Dexie migration history: mail starts at version 1 with
  tables derived from `registry` collection keys + `meta` + `detail tables` + `dispatchOutbox`.

## Tests (bun test)

Port the shape of codecast's store tests where they test engine behavior. Minimum:
- pending protection: optimistic field write survives a contradicting server sync until echo.
- exclude/include lifecycle, delta vs snapshot semantics, pruneAbsentScope.
- altKey stub supersede: create stub → server row arrives → rekey, pending rekeyed,
  field overrides reapplied.
- identity reuse: no-op sync returns previous refs (collection AND row level).
- outbox: enqueue+dispatch parallelism, retire race, coalesce keys, boot drain attempt
  caps, must-deliver never dropped, permanent-error classification.
- groupPatchesByTable: nested paths, undefined→null tombstones, field table mapping,
  singleton vs collection, allowed-fields filtering, stub-id skip.
- wakeSig: rowSigExcluding / makeCollectionSig memoization.
```
