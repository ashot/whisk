import type { DeltaPagePayload } from "./deltaPages";

export function subscribeDeltaPages<Row>(
  subscribe: (
    since: number,
    update: (page: DeltaPagePayload<Row>) => void,
    failed: () => void,
  ) => () => void,
  apply: (rows: Row[]) => void,
  ready: () => void,
  failed: () => void,
): () => void {
  type Page = { since: number; stop: () => void; active: boolean };
  const pages: Page[] = [];
  let active = true;
  const trim = (index: number) => {
    for (const page of pages.splice(index)) {
      page.active = false;
      page.stop();
    }
  };
  const watch = (since: number) => {
    const index = pages.length;
    const page: Page = { since, active: true, stop: () => {} };
    pages.push(page);
    page.stop = subscribe(
      since,
      (payload) => {
        if (!active || !page.active) return;
        apply(payload.rows);
        if (!payload.hasMore) {
          trim(index + 1);
          ready();
        } else if (payload.nextSince <= since) {
          trim(index + 1);
          failed();
        } else if (pages[index + 1]?.since !== payload.nextSince) {
          trim(index + 1);
          watch(payload.nextSince);
        }
      },
      () => {
        if (!active || !page.active) return;
        trim(index + 1);
        failed();
      },
    );
  };
  watch(0);
  return () => {
    active = false;
    trim(0);
  };
}
