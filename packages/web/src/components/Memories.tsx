import React, { useMemo, useState } from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import type { Memory } from "../store/types";
import { categoryMeta } from "@mail/shared/src/lib/categories";
import { useRestoreFocus } from "../lib/useRestoreFocus";
import { KeyCap } from "./KeyCap";

// Everything Whisk knows, in plain text, deletable. No hidden profile: the
// rows here are exactly what the classifier and the drafter read.

const KIND_ORDER: Array<{ kind: Memory["kind"]; title: string }> = [
  { kind: "style", title: "Your voice" },
  { kind: "rule", title: "Filing rules" },
  { kind: "contact", title: "People" },
  { kind: "preference", title: "Preferences" },
];

export function Memories(): React.ReactElement {
  useRestoreFocus();
  const s = useTracked([(s) => s.memories, (s) => s.accountScope]);
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);

  const rows = useMemo(() => {
    const alive = (Object.values(s.memories) as Memory[]).filter((m) => !m.deleted);
    const out: Array<{ header?: string; memory: Memory }> = [];
    for (const { kind, title } of KIND_ORDER) {
      const group = alive
        .filter((m) => m.kind === kind)
        .sort((a, b) => b.updated_at - a.updated_at);
      group.forEach((memory, i) => {
        out.push({ header: i === 0 ? title : undefined, memory });
      });
    }
    return out;
  }, [s.memories]);

  const active = Math.min(index, Math.max(rows.length - 1, 0));
  const close = () => useMailStore.getState().setMemories(false);
  const remove = (m: Memory) => {
    useMailStore.getState().deleteMemory({ memory_id: m._id });
    useMailStore.getState().pushToast("Forgotten");
  };
  const add = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    useMailStore.getState().addMemory({ text: trimmed });
    useMailStore.getState().pushToast("Whisk will remember");
    setText("");
  };

  return (
    <div className="overlay" onClick={close}>
      <div className="palette memories" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          value={text}
          placeholder="Teach Whisk something… (Enter to save)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || (e.key === "j" && !text)) {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, rows.length - 1));
            } else if (e.key === "ArrowUp" || (e.key === "k" && !text)) {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (rows[active]) remove(rows[active].memory);
            }
          }}
        />
        <div className="palette-list memories-list">
          {rows.length === 0 && (
            <div className="palette-empty">
              Nothing yet. Whisk learns from your sent mail, your corrections,
              and whatever you write above.
            </div>
          )}
          {rows.map(({ header, memory }, i) => (
            <React.Fragment key={memory._id}>
              {header && <div className="memories-heading">{header}</div>}
              <div
                className={`memory-row${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setIndex(i)}
              >
                {memory.kind === "rule" && memory.category ? (
                  <span
                    className="cat-dot"
                    style={{ ["--hue" as any]: categoryMeta(memory.category)?.hue }}
                    aria-hidden
                  />
                ) : (
                  <span className="memory-dot" data-kind={memory.kind} aria-hidden />
                )}
                <span className="memory-text">{memory.text}</span>
                <button
                  className="memory-delete"
                  title="Forget (⌘⌫)"
                  tabIndex={-1}
                  onClick={() => remove(memory)}
                >
                  ×
                </button>
              </div>
            </React.Fragment>
          ))}
        </div>
        <div className="picker-foot">
          <KeyCap spec="cmd+backspace" /> forget · everything here is all Whisk
          knows about you
        </div>
      </div>
    </div>
  );
}
