import React from "react";
import { useTracked } from "../store/mailStore";

/** The vim-style pending-sequence ghost, bottom right. */
export function PendingKeys(): React.ReactElement | null {
  const s = useTracked([(s) => s.pendingKeys]);
  if (s.pendingKeys.length === 0) return null;
  return (
    <div className="pending-keys" aria-hidden>
      {s.pendingKeys.map((k, i) => (
        <kbd key={i} className="keycap keycap-ghost">
          {k}
        </kbd>
      ))}
      <span className="pending-keys-ellipsis">…</span>
    </div>
  );
}
