import React, { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useMailStore } from "../store/mailStore";
import type { Cluster } from "../store/types";
import { KeyCap } from "./KeyCap";
import "../design/topics.css";

/** Right-click on a topic at the top of the inbox: hide it, or unhide it.
 *  The mail stays where it is. */
export function TopicMenu({ cluster, x, y, onClose }: { cluster: Cluster; x: number; y: number; onClose: () => void }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  }, [x, y]);
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);
  const hidden = !!cluster.hidden;
  return createPortal(
    <div
      ref={ref}
      className="topic-menu"
      role="menu"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        role="menuitem"
        autoFocus
        onClick={() => { onClose(); useMailStore.getState().hideTopic(cluster._id); }}
      >
        {hidden ? "Unhide" : "Hide"}
        <KeyCap spec="h" />
      </button>
    </div>,
    document.body,
  );
}
