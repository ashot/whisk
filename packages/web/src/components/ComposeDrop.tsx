import React, { useEffect, useState } from "react";
import type { Address } from "@mail/shared/src/store/types";
import { attachToCompose, dataTransferHasFiles, filesFromDataTransfer } from "../lib/composeAttach";
import { useMailStore } from "../store/mailStore";

const names = (to: Address[]) => to.map((a) => a.name ?? a.email).join(", ");

/** Where a dropped file lands: the open composer, else the reply that
 *  opens for the conversation on screen, else a new message. */
function useDropTarget(): string {
  return useMailStore((s) => {
    const d = s.composeDraftId ? s.drafts[s.composeDraftId] : null;
    if (d) {
      if (d.mode === "reply" || d.mode === "replyAll") return `Reply to ${names(d.to) || "\u2026"}`;
      if (d.mode === "forward") return `Forward \u00b7 ${d.subject || "(no subject)"}`;
      return d.subject || "New message";
    }
    const t = s.openThreadId ? s.threads[s.openThreadId] : null;
    if (t) return `Reply \u00b7 ${t.subject || "(no subject)"}`;
    return "New message";
  });
}

/** Page-level file drop. While a file is held over the window the veil
 *  takes every drag event (message bodies are iframes, which would otherwise
 *  swallow the drop) and the composer stays above it as the landing. */
export function ComposeDrop(): React.ReactElement | null {
  const [over, setOver] = useState(false);
  const target = useDropTarget();

  useEffect(() => {
    let depth = 0;
    const has = (e: DragEvent) => dataTransferHasFiles(e.dataTransfer);
    const show = (on: boolean) => {
      setOver(on);
      document.documentElement.classList.toggle("is-file-drag", on);
    };
    const enter = (e: DragEvent) => {
      if (!has(e)) return;
      if (depth === 0) show(true);
      depth++;
    };
    const leave = (e: DragEvent) => {
      if (!has(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) show(false);
    };
    const overEv = (e: DragEvent) => {
      if (!has(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      show(false);
      if (!has(e)) return;
      e.preventDefault();
      const files = filesFromDataTransfer(e.dataTransfer);
      if (files.length) void attachToCompose(files);
    };
    const end = () => {
      depth = 0;
      show(false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overEv);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overEv);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragend", end);
      document.documentElement.classList.remove("is-file-drag");
    };
  }, []);

  if (!over) return null;
  return (
    <div className="compose-drop-veil" aria-hidden>
      <div className="compose-drop-mark">
        <svg
          viewBox="0 0 16 16"
          width="36"
          height="36"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M13 6.2 7.1 12a2.9 2.9 0 0 1-4.1-4.1l6.4-6.4a1.95 1.95 0 0 1 2.8 2.8L5.8 10.7a1 1 0 0 1-1.4-1.4l5.7-5.7" />
        </svg>
        <span>Drop to attach</span>
        <span className="compose-drop-to">{target}</span>
      </div>
    </div>
  );
}
