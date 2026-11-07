import React, { useMemo, useState } from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import { followupOptions, snoozeOptions } from "@mail/shared/src/lib/times";
import type { Thread } from "../store/types";
import { useRestoreFocus } from "../lib/useRestoreFocus";

// One picker, two intents: "leave me alone until" (snooze) and "nudge me if
// nobody replies by" (follow-up watch). Numbers commit instantly.

export function TimePicker(): React.ReactElement | null {
  useRestoreFocus();
  const s = useTracked([
    (s) => s.timePicker,
    (s) => s.selected,
    (s) => s.focusedThreadId,
    (s) => s.threads,
  ]);
  const [index, setIndex] = useState(0);
  const mode = s.timePicker;
  const options = useMemo(
    () => (mode === "followup" ? followupOptions() : snoozeOptions()),
    [mode],
  );
  if (!mode) return null;

  const targetIds = Object.keys(s.selected).length
    ? Object.keys(s.selected)
    : s.focusedThreadId
      ? [s.focusedThreadId]
      : [];
  const targets = targetIds.map((id) => s.threads[id]).filter(Boolean) as Thread[];
  const noun = targets.length > 1 ? `${targets.length} conversations` : "conversation";

  const close = () => useMailStore.getState().setTimePicker(null);
  const pick = (at: number) => {
    const st = useMailStore.getState();
    if (mode === "snooze") st.snooze(at, targetIds);
    else st.watchReply(at, targetIds);
    close();
  };

  return (
    <div className="overlay" onClick={close}>
      <div className="palette time-picker" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          readOnly
          value=""
          placeholder={
            mode === "snooze"
              ? `Snooze ${noun} until…`
              : `Nudge me about ${noun} if no reply by…`
          }
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "j") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, options.length - 1));
            } else if (e.key === "ArrowUp" || e.key === "k") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (options[index]) pick(options[index].at);
            } else if (/^[1-9]$/.test(e.key)) {
              e.preventDefault();
              const option = options[Number(e.key) - 1];
              if (option) pick(option.at);
            }
          }}
        />
        <div className="palette-list">
          {options.map((option, i) => (
            <button
              key={option.label}
              className={`palette-item${i === index ? " is-active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(option.at)}
            >
              <span className="cat-key">{i + 1}</span>
              <span className="palette-item-title">{option.label}</span>
              <span className="palette-item-hint">{option.detail}</span>
            </button>
          ))}
        </div>
        {mode === "followup" && (
          <div className="picker-foot">
            A reply before then clears the watch on its own.
          </div>
        )}
      </div>
    </div>
  );
}
