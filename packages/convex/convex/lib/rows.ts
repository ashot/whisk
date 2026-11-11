import { Doc } from "../_generated/dataModel";
import { hasCalendarScope } from "../gmail/oauth";

/** A re-score running longer than this died; its pulse comes down. */
export const LENS_STALE_MS = 30 * 60 * 1000;

// A session can hold several accounts, so every synced row keeps `account_id`
// — it is how the client scopes views, sends, and markers per account. These
// projections are the only shape any query returns.

/** How many of an account's most recent threads a client holds, and so how
 *  deep grouping and filters look: what they touch is always something the
 *  app can show. */
export const THREAD_WINDOW = 2000;

export function publicLabel(row: Doc<"labels">) {
  return row;
}

export function publicDraft(row: Doc<"drafts">) {
  return row;
}

export function publicMessage(row: Doc<"messages">) {
  return row;
}

/**
 * Thread list rows never carry bodies — that is the whole reason `listThreads`
 * is cheap enough to hold a thousand rows in the client store.
 */
export function publicThread(row: Doc<"threads">) {
  return row;
}

/** An account row, minus anything the client has no business reading. */
export function publicAccount(row: Doc<"accounts">) {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    email: row.email,
    name: row.name,
    picture: row.picture,
    provider: row.provider,
    send_as: row.send_as,
    sync_status: row.sync_status,
    sync_error: row.sync_error,
    last_synced_at: row.last_synced_at,
    // A clustering pass is booked or running — the sweep shows a pulse.
    clustering: !!row.cluster_job,
    cluster_error: row.cluster_error,
    cluster_progress: row.cluster_progress,
    // A lens re-score is booked or running (and not dead): the tabs pulse.
    lens_sorting: !!row.lens_job && (!row.lens_started_at || row.lens_started_at > Date.now() - LENS_STALE_MS),
    // The client offers "turn on calendar" to an account that never granted
    // it, and never guesses from the provider alone. A demo mailbox has a
    // seeded calendar and nothing to grant.
    calendar_enabled: row.provider === "demo" || hasCalendarScope(row.scopes),
    calendar_synced_at: row.calendar_synced_at,
    calendar_error: row.calendar_write_error ?? row.calendar_error,
    updated_at: row.updated_at,
  };
}

export function publicClientState(row: Doc<"client_state"> | null) {
  return row;
}
