import { useSyncExternalStore } from "react";

/** A phone: the rail folds into a drawer and rows stack into cards. Keep in
 *  step with the `max-width: 760px` blocks in design/mobile.css. */
const NARROW = "(max-width: 760px)";

const media = typeof matchMedia === "function" ? matchMedia(NARROW) : null;

function subscribe(cb: () => void): () => void {
  media?.addEventListener("change", cb);
  return () => media?.removeEventListener("change", cb);
}

export function isNarrow(): boolean {
  return media?.matches ?? false;
}

export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, isNarrow, () => false);
}
