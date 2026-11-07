import React, { useState } from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import { LOOSE_SECTION } from "../store/selectors";
import type { Thread } from "../store/types";
import { TopicEditor } from "./TopicEditor";
import { KeyCap } from "./KeyCap";
import "../design/topics.css";

/** A description without its "not this" tail: the tail is for the model
 *  deciding membership, the head is for a person reading the page. */
function gist(description: string): string {
  return description.replace(/\s*[;—–-]\s*(?:but\s+)?not\b[^.]*\.?$/i, "").trim();
}

/** The band under a topic page's title: the way back, what it holds and
 *  what it is, and Edit. Hide lives on the inbox section, via right-click.
 *  The loose section is the inbox mail no topic claimed. */
export function TopicHead({ clusterId, threads }: { clusterId: string; threads: Thread[] }): React.ReactElement | null {
  const s = useTracked([(s) => s.clusters, (s) => s.accounts]);
  const [editing, setEditing] = useState(false);
  const st = useMailStore.getState();
  const back = <button className="topic-back" onClick={() => st.setView("inbox")} title="Back to the inbox (esc)">← Inbox</button>;
  if (clusterId === LOOSE_SECTION) {
    return <div className="topic-head"><div className="topic-head-row">
      {back}
      <span className="topic-head-desc">Inbox conversations no topic claimed. Select some and press <KeyCap spec="T" /> to gather them; Whisk tries again as new mail arrives.</span>
    </div></div>;
  }
  const c = s.clusters[clusterId];
  if (!c || c.deleted) return null;
  const parent = c.parent_id ? s.clusters[c.parent_id] : undefined;
  const unread = threads.filter((t) => t.is_unread).length;
  const many = Object.keys(s.accounts).length > 1;
  const meta = [
    unread ? `${unread} unread` : `${threads.length} ${threads.length === 1 ? "conversation" : "conversations"}`,
    c.source === "user" ? "yours" : "",
    many ? (s.accounts[c.account_id]?.email ?? "") : "",
    c.hidden ? "hidden" : "",
  ].filter(Boolean).join(" · ");
  return <div className="topic-head" style={{ ["--hue" as any]: c.hue }}>
    <div className="topic-head-row">
      {back}
      {parent && !parent.deleted && <button className="topic-crumb" style={{ ["--hue" as any]: parent.hue }} onClick={() => st.setView(`cluster:${parent._id}`)} title={parent.description || undefined}>in {parent.name}</button>}
      <span className="topic-head-desc">
        <span className="topic-head-gist" title={c.description || undefined}>{gist(c.description) || <em>No description yet — add one so Whisk knows what joins this topic.</em>}</span>
        <em>{meta}</em>
      </span>
      <button className="topic-back topic-edit" aria-expanded={editing} onClick={() => setEditing(!editing)}>Edit</button>
    </div>
    {editing && <TopicEditor cluster={c} close={() => setEditing(false)} />}
  </div>;
}
