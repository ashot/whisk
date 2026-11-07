# Whisk

A Gmail client that is local first. Everything in this rule applies to every
package: web, mobile, desktop, cli, shared and convex.

## Local first is the architecture, not a feature

The app must work with no network. The local store is the source of truth
for the screen. The server is a mirror that catches up behind the user.
Syncing is secondary. If a change makes the app depend on the network to
render, respond, or keep state, the change is wrong.

Concretely:

- **Every read renders from the local store.** No screen, row, badge, count,
  toggle or view mode waits for a query. The store hydrates from IndexedDB at
  boot and the app is usable from the cached data before the socket connects.
- **Every write is an optimistic local action.** Use the `action` decorator
  from `createLocalFirstStore` (see `packages/shared/src/store/mailStore.ts`
  and `docs/PLATFORM_SPEC.md`). The action mutates the store first, then the
  platform middleware queues the dispatch in the durable outbox. Never call a
  Convex mutation or action directly from a component or a store method.
- **A server echo never clobbers a local change.** Register every synced
  table and every client preference key in
  `packages/shared/src/store/registry.ts`. A preference the user can toggle
  is `local_wins`. Data the user edits is `localFirst: true`. Anything
  user authored or state changing is in `mustDeliverActions`.
- **Model work is a background producer, not a gate.** Clustering, lane
  classification, filters, summaries and drafts run on the server and land
  as synced rows. The UI shows what it has, marks what is stale or pending,
  and never blocks on the model. Hand edits are final and survive any later
  model run.
- **Offline is a state, not an error.** Queued writes show as pending. Sends,
  archives, moves, renames and preference changes all succeed offline and
  drain later. Only features that cannot exist without the network (remote
  search of mail not yet cached, sign in) may say so, and they degrade to the
  local equivalent where one exists.
- **New state goes through the platform.** Do not add ad hoc `useState`,
  `localStorage`, or component level fetches for anything the user would
  expect to persist or to be the same on another device. Add a registry
  entry and a store action instead.

Before finishing any change, verify it offline: load the app, cut the
network, do the action, reload, confirm the change is still there, restore
the network, confirm it reached the server. Treat a regression here as a
blocking bug.

## Where things live

- `packages/platform` is the generic engine ported from codecast. Keep the
  parts marked byte identical in `docs/PLATFORM_SPEC.md` untouched.
- `packages/shared/src/store` holds the app store, registry, selectors and
  types, shared by web, mobile and cli.
- `packages/convex` is the sync backend and the AI layer. Its dispatch
  handlers must be idempotent, because the outbox retries them.
