import React, { useMemo, useState } from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import { shownTopic, topLevel } from "../store/selectors";
import type { Pile } from "../store/selectors";
import { useRestoreFocus } from "../lib/useRestoreFocus";
import { HintPair } from "./KeyCap";
import "../design/topics.css";

/** Move the targeted conversations into a topic, out of every topic, or
 *  into a new one named here. Arrow keys walk the list; Enter picks. */
export function ClusterPicker(): React.ReactElement {
  useRestoreFocus();
  const s = useTracked([s => s.threads, s => s.clusters, s => s.selected, s => s.focusedThreadId]);
  const [name, setName] = useState("");
  const [index, setIndex] = useState(0);
  const ids = Object.keys(s.selected).length ? Object.keys(s.selected) : s.focusedThreadId ? [s.focusedThreadId] : [];
  const targets = ids.map(id => s.threads[id]).filter(Boolean);
  const account = targets[0]?.account_id;
  const mixed = targets.some(t => t.account_id !== account);
  const current = new Set(targets.map(t => shownTopic(t.cluster_id ? s.clusters[t.cluster_id] : undefined, s.clusters)?._id).filter(Boolean));
  // The topics of the targets' mailbox, the ones the screen shows. Mail
  // moved to a theme sits in it directly.
  const piles = useMemo(() => (account ? topLevel(s.threads, s.clusters, account) : []) as Pile[], [s.threads, s.clusters, account]);
  const needle = name.trim().toLowerCase();
  const rows = piles.filter((p) => !needle || p.meta.name.toLowerCase().includes(needle) || p.meta.hint.toLowerCase().includes(needle));
  const exact = rows.some((p) => p.meta.name.toLowerCase() === needle);
  // Choices in order: every matching topic, then "no topic", then "create".
  const choices: Array<{ key: string; run: () => void; label: React.ReactNode; hint?: string; hue?: number; active?: boolean }> = [
    ...rows.map((p) => ({ key: p.meta.id, hue: p.meta.hue, active: current.has(p.meta.id), hint: p.meta.hint, run: () => choose(p.meta.id), label: <><span className="palette-item-title">{p.meta.name}</span>{p.meta.hint && <span className="palette-item-hint picker-hint">{p.meta.hint}</span>}<span className="picker-count">{p.threads.length}</span></> })),
    ...(!needle || "no topic".includes(needle) ? [{ key: "none", run: () => choose(null), label: <span className="palette-item-title">No topic · keep separate</span>, active: targets.length > 0 && targets.every(t => !t.cluster_id) }] : []),
    ...(needle && !exact ? [{ key: "create", run: () => create(), label: <span className="palette-item-title">Create “{name.trim()}” from {Object.keys(s.selected).length ? `${targets.length} selected` : "this conversation"}</span> }] : []),
  ];
  const at = Math.min(index, Math.max(choices.length - 1, 0));
  const close = () => useMailStore.getState().setClusterPicker(false);
  function choose(id: string | null) { if (mixed || !targets.length) return; useMailStore.getState().moveToTopic(id, ids); close(); }
  function create() { if (!name.trim() || mixed || !targets.length) return; useMailStore.getState().newTopicFrom(name.trim(), ids); close(); }
  return <div className="overlay" onClick={close}><div className="palette" role="dialog" aria-modal="true" aria-label="Move to topic" onClick={e => e.stopPropagation()}>
    <input className="palette-input" autoFocus aria-label="Find or create a topic" placeholder={targets.length ? `Move ${targets.length === 1 ? "this conversation" : `${targets.length} conversations`} to…` : "Select a conversation first"} value={name} maxLength={48}
      onChange={e => { setName(e.target.value); setIndex(0); }}
      onKeyDown={e => {
        if (e.key === "ArrowDown") { e.preventDefault(); setIndex(Math.min(at + 1, choices.length - 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setIndex(Math.max(at - 1, 0)); }
        else if (e.key === "Enter") { e.preventDefault(); choices[at]?.run(); }
      }} />
    <div className="palette-list" role="listbox">
      {!targets.length ? <p className="palette-empty">Select a conversation first.</p> : mixed ? <p className="palette-empty">Select conversations from one mailbox to move them together.</p> : choices.length === 0 ? <p className="palette-empty">No topic matches.</p> :
        choices.map((c, i) => <button key={c.key} role="option" aria-selected={i === at} className={`palette-item${i === at ? " is-active" : ""}${c.active ? " is-current" : ""}`} onMouseEnter={() => setIndex(i)} onClick={c.run}>
          {c.hue !== undefined && <span className="cat-dot" style={{ "--hue": c.hue } as React.CSSProperties} />}
          {c.label}
          {c.active && <span className="picker-current">current</span>}
        </button>)}
    </div>
    <div className="picker-foot"><span>Your placements, and the topics you put them in, stay put when Whisk regroups.</span><span className="picker-keys"><HintPair spec="arrowdown">choose</HintPair><HintPair spec="enter">move</HintPair><HintPair spec="escape">close</HintPair></span></div>
  </div></div>;
}
