import React, { useState } from "react";
import { useMailStore } from "../store/mailStore";
import { LOOSE_SECTION } from "../store/selectors";
import type { InboxItem } from "../store/selectors";
import type { Account, Cluster } from "../store/types";
import { TopicMenu } from "./TopicMenu";

/** The unified view's per-account marker: which mailbox a row belongs to. */
export type Mailbox = { email: string; color: string };
import "../design/topics.css";

/** The head of a section: the topic's name and its numbers. Click or
 *  Enter opens the topic's own page; `e` archives all of it and `h`
 *  hides it. Right-click hides or unhides without archiving. The section
 *  holding mail no topic claimed has a page but no hide. */
export const SectionRow = React.memo(function SectionRow({ item, focused, mailbox }: { item: Extract<InboxItem, { kind: "section" }>; focused: boolean; mailbox?: Mailbox }): React.ReactElement {
  const st = useMailStore.getState();
  const { pile } = item;
  const c = pile.meta.cluster;
  const total = pile.threads.length;
  const [menu, setMenu] = useState<{ cluster: Cluster; x: number; y: number } | null>(null);
  return (
    <div
      className={`row section-row${focused ? " is-focused" : ""}${pile.unread ? " is-unread" : ""}${c ? "" : " is-loose"}`}
      style={{ ["--hue" as any]: pile.meta.hue }}
      title={c?.description ? `${c.description}. Enter opens it; e archives all of it; right-click hides it.` : c ? "Enter opens it; e archives all of it; right-click hides it." : pile.meta.hint}
      role="button"
      onClick={() => { st.focusThread(item.id); st.setView(pile.meta.view); }}
      onContextMenu={c ? (e) => { e.preventDefault(); e.stopPropagation(); st.focusThread(item.id); setMenu({ cluster: c, x: e.clientX, y: e.clientY }); } : undefined}
    >
      <span className="row-mark" aria-hidden />
      {mailbox && <span className="row-acct-dot" style={{ ["--acct" as any]: mailbox.color }} title={mailbox.email} aria-hidden />}
      <span className="section-name">{pile.meta.name}</span>
      <span className="section-count">{pile.unread ? `${pile.unread} new · ` : ""}{total}</span>
      {menu && <TopicMenu cluster={menu.cluster} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
});

/** The line closing a section that runs past its peek: the rest, and the
 *  way to it. Not a cursor stop; Enter on the head goes to the same page. */
export function MoreRow({ item }: { item: Extract<InboxItem, { kind: "more" }> }): React.ReactElement {
  const st = useMailStore.getState();
  return (
    <button className="section-more" style={{ ["--hue" as any]: item.pile.meta.hue }} tabIndex={-1} onClick={() => st.setView(item.pile.meta.view)}>
      {item.rest} more{item.pile.meta.id === LOOSE_SECTION ? "" : ` in ${item.pile.meta.name}`}
    </button>
  );
}

/** The footer naming hidden topics: they are out of the list, their mail
 *  stays. Click opens the page; right-click brings the topic back. */
export function MutedFoot({ item }: { item: Extract<InboxItem, { kind: "muted" }> }): React.ReactElement {
  const st = useMailStore.getState();
  const [menu, setMenu] = useState<{ cluster: Cluster; x: number; y: number } | null>(null);
  return (
    <div className="section-muted" title="Hidden from the inbox. Right-click a name to bring it back.">
      <span>Hidden</span>
      {item.piles.map((p) => {
        const c = p.meta.cluster;
        return <button key={p.meta.id} className="section-muted-link" tabIndex={-1} onClick={() => st.setView(p.meta.view)} onContextMenu={c ? (e) => { e.preventDefault(); e.stopPropagation(); setMenu({ cluster: c, x: e.clientX, y: e.clientY }); } : undefined}>{p.meta.name}</button>;
      })}
      {menu && <TopicMenu cluster={menu.cluster} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** The inbox header's one control: the plain list, or the inbox as
 *  topics. Present from the first day, so the feature can be found;
 *  asleep until Whisk has read enough to have topics. */
export function GroupToggle({ grouped, ready, off }: { grouped: boolean; ready: boolean; off: boolean }): React.ReactElement {
  const st = useMailStore.getState();
  const why = off ? "Topics are off — turn them on in Settings" : "Whisk is still reading your inbox";
  return (
    <span className="topic-segments list-grouping" role="group" aria-label="Show the inbox as">
      <button aria-pressed={!grouped} onClick={() => st.setInboxGrouped(false)} title="Every conversation, newest first (v)">List</button>
      <button aria-pressed={grouped} disabled={!ready} onClick={() => st.setInboxGrouped(true)} title={ready ? "One section per topic, newest first (v)" : why}>Topics</button>
    </span>
  );
}

/** One line per mailbox being grouped: how far the pass has read. */
export function GroupingProgress({ accounts, many }: { accounts: Account[]; many: boolean }): React.ReactElement | null {
  const rows = accounts.filter((a) => a.clustering);
  if (!rows.length) return null;
  return <div className="topic-progress">
    <span className="sr-only" role="status" aria-live="polite">Finding topics</span>
    {rows.map((a) => {
      const p = a.cluster_progress;
      const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
      const text = !p ? "starting" : p.tidy ? "almost there" : `${p.done} of ${p.total} conversations read`;
      return <div className="topic-progress-row" key={a._id}>
        <span className="topic-progress-bar" aria-hidden><span style={{ width: `${p ? Math.max(pct, 3) : 3}%` }} className={p && !p.tidy ? "" : "is-indeterminate"} /></span>
        <span className="topic-progress-text" title={a.email}>Finding topics{many ? ` in ${a.email}` : ""} · {text}</span>
      </div>;
    })}
  </div>;
}
