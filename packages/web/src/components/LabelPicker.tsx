import React, { useMemo, useState } from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import type { Label, Thread } from "../store/types";
import { useRestoreFocus } from "../lib/useRestoreFocus";

export function LabelPicker(): React.ReactElement {
  useRestoreFocus();
  const s = useTracked([
    (s) => s.labels,
    (s) => s.selected,
    (s) => s.focusedThreadId,
    (s) => s.threads,
  ]);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const targetIds = Object.keys(s.selected).length
    ? Object.keys(s.selected)
    : s.focusedThreadId
      ? [s.focusedThreadId]
      : [];
  const targets = targetIds.map((id) => s.threads[id]).filter(Boolean) as Thread[];

  const labels = useMemo(
    () =>
      (Object.values(s.labels) as Label[])
        .filter((l) => l.kind === "user" && !l.deleted)
        .filter((l) => l.name.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [s.labels, query],
  );
  const active = Math.min(index, Math.max(labels.length - 1, 0));
  const close = () => useMailStore.getState().setLabelPicker(false);

  const toggle = (l: Label) => {
    useMailStore.getState().applyLabelToggle(l.gmail_id, targetIds);
    close();
  };

  return (
    <div className="overlay" onClick={close}>
      <div className="palette label-picker" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          value={query}
          placeholder={`Label ${targets.length > 1 ? `${targets.length} conversations` : "conversation"}…`}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, labels.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (labels[active]) toggle(labels[active]);
            }
          }}
        />
        <div className="palette-list">
          {labels.length === 0 && <div className="palette-empty">No labels.</div>}
          {labels.map((l, i) => {
            const allHave = targets.length > 0 && targets.every((t) => t.label_ids.includes(l.gmail_id));
            return (
              <button
                key={l._id}
                className={`palette-item${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => toggle(l)}
              >
                <span className="rail-label-dot" style={{ background: l.color?.bg }} aria-hidden />
                <span className="palette-item-title">{l.name}</span>
                <span className="palette-item-hint">{allHave ? "remove" : "apply"}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
