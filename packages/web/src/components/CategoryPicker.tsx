import React, { useState } from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import { CATEGORIES } from "@mail/shared/src/lib/categories";
import type { Thread } from "../store/types";
import { useRestoreFocus } from "../lib/useRestoreFocus";

// File a conversation under a lane. One keystroke per lane (1–9), and the
// correction teaches: the sender's other mail follows.

type Row = {
  id: string | null;
  name: string;
  hint: string;
  hue: number | null;
};

const ROWS: Row[] = [
  { id: null, name: "Primary", hint: "Real correspondence", hue: null },
  ...CATEGORIES.map((c) => ({ id: c.id as string, name: c.name, hint: c.hint, hue: c.hue as number | null })),
];

export function CategoryPicker(): React.ReactElement {
  useRestoreFocus();
  const s = useTracked([
    (s) => s.selected,
    (s) => s.focusedThreadId,
    (s) => s.threads,
  ]);
  const [index, setIndex] = useState(0);

  const targetIds = Object.keys(s.selected).length
    ? Object.keys(s.selected)
    : s.focusedThreadId
      ? [s.focusedThreadId]
      : [];
  const targets = targetIds.map((id) => s.threads[id]).filter(Boolean) as Thread[];
  const current = targets.length === 1 ? (targets[0].category ?? null) : undefined;

  const close = () => useMailStore.getState().setCategoryPicker(false);
  const pick = (row: Row) => {
    useMailStore.getState().fileUnder(row.id as any, targetIds);
    close();
  };

  return (
    <div className="overlay" onClick={close}>
      <div className="palette cat-picker" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          readOnly
          value=""
          placeholder={`File ${targets.length > 1 ? `${targets.length} conversations` : "conversation"} under…`}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "j") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, ROWS.length - 1));
            } else if (e.key === "ArrowUp" || e.key === "k") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(ROWS[index]);
            } else if (/^[1-9]$/.test(e.key)) {
              e.preventDefault();
              const row = ROWS[Number(e.key) - 1];
              if (row) pick(row);
            }
          }}
        />
        <div className="palette-list">
          {ROWS.map((row, i) => (
            <button
              key={row.id ?? "primary"}
              className={`palette-item${i === index ? " is-active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(row)}
            >
              <span className="cat-key">{i + 1}</span>
              <span
                className="cat-dot"
                style={
                  row.hue !== null ? ({ ["--hue" as any]: row.hue } as any) : undefined
                }
                data-primary={row.hue === null || undefined}
                aria-hidden
              />
              <span className="palette-item-title">{row.name}</span>
              <span className="palette-item-hint">
                {current !== undefined && current === row.id ? "current" : row.hint}
              </span>
            </button>
          ))}
        </div>
        <div className="picker-foot">
          Whisk remembers the sender and re-files their other mail.
        </div>
      </div>
    </div>
  );
}
