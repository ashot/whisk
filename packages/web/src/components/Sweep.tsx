import React, { useEffect, useRef } from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import { inboxClusters } from "../store/selectors";
import type { Pile } from "../store/selectors";
import { HintPair } from "./KeyCap";
import { NavButton } from "./MobileNav";
import "../design/topics.css";

/** The senders line: distinct display names, so two addresses that both
 *  present as "Care.com" read once. */
export function senderNames(pile: Pile, n = 3): string {
  return [...new Set(pile.senders.map((s) => s.name))].slice(0, n).join(", ");
}

function Card({ pile, focused, select }: { pile: Pile; focused: boolean; select: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: "nearest" }); }, [focused]);
  const open = () => { select(); useMailStore.getState().sweepAct("open"); };
  return <div className="topic-card-wrap" ref={ref}>
    <div className={`sweep-card${focused ? " is-focused" : ""}`} style={{ "--hue": pile.meta.hue } as React.CSSProperties}>
      <span className="sweep-card-bar" aria-hidden />
      <button className="sweep-card-main topic-open" onFocus={select} onClick={open}>
        <span className="sweep-card-head">
          <span className="sweep-card-name">{pile.meta.name}</span>
          <span className="sweep-card-count">{pile.threads.length}<span className="sweep-card-unread">{pile.unread ? ` · ${pile.unread} unread` : ""}</span></span>
        </span>
        <span className="sweep-senders">{senderNames(pile)}</span>
        <span className="sweep-card-samples">{pile.threads.slice(0, 2).map(t => <span key={t._id} className="sweep-card-sample">{t.subject || "(no subject)"}</span>)}</span>
      </button>
      <button className="sweep-card-archive" title="Archive every conversation in it (e)" onFocus={select} onClick={() => { select(); useMailStore.getState().sweepAct("archive"); }}>
        Archive all
      </button>
    </div>
  </div>;
}

/** The inbox folded into its lanes, one card each, to archive whole. */
export function Sweep(): React.ReactElement {
  const s = useTracked([s => s.threads, s => s.accountScope, s => s.sweepIndex, s => s.sweepFocusId]);
  const st = useMailStore.getState();
  const piles = inboxClusters(s.threads, s.accountScope);
  const focusedId = st.sweepFocused()?.meta.id;
  return <div className="list sweep">
    <header className="list-head"><NavButton /><h1 className="list-title">Sweep</h1><span className="list-count">{piles.length} {piles.length === 1 ? "lane" : "lanes"}</span><button className="settings-btn" onClick={() => st.setFilters(true)}>Filters</button></header>
    {piles.length === 0
      ? <div className="empty-state"><div className="empty-title">Nothing to sweep.</div><div className="empty-sub">No filed conversations in the inbox.</div></div>
      : <div className="list-scroll sweep-scroll">
        <div className="sweep-cards">
          {piles.map((pile, i) => <Card key={pile.meta.id} pile={pile} focused={pile.meta.id === focusedId} select={() => st.setSweepFocus(pile.meta.id, i)} />)}
        </div>
        <div className="sweep-foot"><HintPair spec="j">next</HintPair><HintPair spec="enter">open</HintPair><HintPair spec="e">archive lane</HintPair><HintPair spec="escape">inbox</HintPair></div>
      </div>}
  </div>;
}
