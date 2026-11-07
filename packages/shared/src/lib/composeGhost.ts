// Key policy for the empty-composer ghost (Codecast's composer suggestions).
// The ghost is only alive while the box is empty. Tab takes the shown
// suggestion; up/down (and shift-tab) step through the others. Any typed
// text dismisses it, and the arrows go back to moving the caret.

export type GhostKey = "accept" | "next" | "prev";

export function ghostKeyAction(opts: {
  empty: boolean;
  count: number;
  key: string;
  shift: boolean;
}): GhostKey | null {
  if (!opts.empty || opts.count === 0) return null;
  if (opts.key === "Tab" && !opts.shift) return "accept";
  if (opts.key === "Tab" && opts.shift && opts.count > 1) return "prev";
  if ((opts.key === "ArrowDown" || opts.key === "ArrowUp") && opts.count < 2) return null;
  if (opts.key === "ArrowDown") return "next";
  if (opts.key === "ArrowUp") return "prev";
  return null;
}
