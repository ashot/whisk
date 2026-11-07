import React, { useEffect } from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import { KeyCap } from "./KeyCap";
import { useAppUpdate } from "../lib/appUpdate";

export function Toasts(): React.ReactElement | null {
  const s = useTracked([(s) => s.toasts]);
  const update = useAppUpdate();

  useEffect(() => {
    if (s.toasts.length === 0) return;
    const next = Math.min(...s.toasts.map((t) => t.expiresAt));
    const timer = setTimeout(() => {
      const now = Date.now();
      const st = useMailStore.getState();
      for (const t of st.toasts) if (t.expiresAt <= now) st.dismissToast(t.id);
    }, Math.max(next - Date.now(), 50));
    return () => clearTimeout(timer);
  }, [s.toasts]);

  if (s.toasts.length === 0 && !update) return null;
  return (
    <div className="toasts" role="status">
      {update && (
        <div className="toast toast-update">
          <span>{update.text}</span>
          <button onClick={update.run}>{update.action}</button>
        </div>
      )}
      {s.toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span>{t.text}</span>
          {t.kind === "undo" && (
            <button type="button" className="toast-action" onClick={() => useMailStore.getState().undo()}>
              <KeyCap spec="u" /> undo
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
