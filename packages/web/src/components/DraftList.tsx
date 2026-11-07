import React, { useEffect, useRef } from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import { visibleDrafts } from "../store/selectors";
import { relativeDate } from "../lib/format";
import { useCoarseNow } from "@mail/platform";
import { NavButton } from "./MobileNav";

export function DraftList(): React.ReactElement {
  const s = useTracked([(s) => s.drafts, (s) => s.focusedThreadId, (s) => s.accountScope]);
  const drafts = visibleDrafts(s.drafts, s.accountScope);
  const now = useCoarseNow(30_000);
  const focusedRef = useRef<HTMLDivElement>(null);

  // Keep the cursor on screen when j/k walks past the fold. The list is short
  // enough to render whole, so this is a scroll nudge, not a virtualizer.
  useEffect(() => {
    focusedRef.current?.scrollIntoView({ block: "nearest" });
  }, [s.focusedThreadId]);

  return (
    <div className="list">
      <header className="list-head">
        <NavButton />
        <h1 className="list-title">Drafts</h1>
        <span className="list-count">{drafts.length || ""}</span>
      </header>
      {drafts.length === 0 ? (
        <div className="empty-state">
          <div className="empty-title">No drafts.</div>
          <div className="empty-sub">Half-written thoughts live here.</div>
        </div>
      ) : (
        <div className="list-scroll">
          {drafts.map((d) => {
            const focused = d.client_id === s.focusedThreadId;
            return (
              <div
                key={d.client_id}
                ref={focused ? focusedRef : undefined}
                className={`row${focused ? " is-focused" : ""}`}
                onClick={() => useMailStore.getState().openDraft(d.client_id)}
              >
                <span className="row-mark" aria-hidden />
                {/* Holds the star column open so draft rows share the thread grid. */}
                <span className="row-star" aria-hidden />
                <span className="row-from row-draft-tag">Draft</span>
                <span className="row-text">
                  <span className="row-subject">{d.subject || "(no subject)"}</span>
                  <span className="row-snippet">{d.body_text.slice(0, 90) || "empty"}</span>
                </span>
                <span className="row-date">{relativeDate(d.updated_at, now)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
