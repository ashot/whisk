// One page from the sync rail's delta channel: rows changed after a
// watermark, the watermark to resume from, and whether the server trimmed
// the page.
export type DeltaPagePayload<Row> = {
  rows: Row[];
  nextSince: number;
  hasMore: boolean;
};

/**
 * Apply one delta payload, then drain the pages behind it.
 *
 * The watermark comes from the server's `nextSince`, never from the last
 * row's own stamp: rows written in one transaction share an `updated_at`,
 * and the server holds `nextSince` at the last timestamp it fully returned.
 * Following anything else can skip the tail of a same-timestamp group.
 *
 * The first payload's rows are applied synchronously, before any await, so a
 * caller can read the store right after this returns its promise. Resolves to
 * the final watermark.
 */
export async function drainDeltaPages<Row>(
  first: DeltaPagePayload<Row>,
  fetchPage: (since: number) => Promise<DeltaPagePayload<Row>>,
  apply: (rows: Row[]) => void,
): Promise<number> {
  apply(first.rows);
  let { nextSince, hasMore } = first;
  while (hasMore) {
    const page = await fetchPage(nextSince);
    apply(page.rows);
    // A page claiming more without advancing would spin forever; stop and let
    // the next subscription tick deliver the rest.
    if (page.hasMore && page.nextSince <= nextSince) return page.nextSince;
    nextSince = page.nextSince;
    hasMore = page.hasMore;
  }
  return nextSince;
}
