// The store owns the search gesture; the sync layer owns the network. This
// seam lets commitSearch fire a remote search without the store importing
// ConvexSync (which imports the store back).

import type { Thread } from "./types";

export type RemoteSearchPage = {
  /** Hit rows in Gmail's rank order; already-known rows ride along too. */
  rows: Thread[];
  /** Opaque; pass back for the next page. Null when the mailbox is drained. */
  cursor: string | null;
};

type RemoteSearch = (q: string, cursor: string | null) => Promise<RemoteSearchPage>;

let handler: RemoteSearch | null = null;

export function setRemoteSearch(fn: RemoteSearch | null): void {
  handler = fn;
}

/** One page of whole-mailbox hits for `q`. Empty when nothing is wired. */
export async function remoteSearch(
  q: string,
  cursor: string | null,
): Promise<RemoteSearchPage> {
  return handler ? await handler(q, cursor) : { rows: [], cursor: null };
}
