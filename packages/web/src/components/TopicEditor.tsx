import React, { useState } from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import type { Cluster } from "../store/types";
import { KeyCap } from "./KeyCap";
import "../design/topics.css";

/** The editor behind a topic's Edit: its name, the sentence Whisk reads
 *  to decide what joins it, and the two repairs — fold it into another
 *  topic, or take it apart. */
export function TopicEditor({ cluster: c, close }: { cluster: Cluster; close: () => void }): React.ReactElement {
  const [name, setName] = useState(c.name);
  const [description, setDescription] = useState(c.description);
  const [into, setInto] = useState("");
  const [confirming, setConfirming] = useState(false);
  const s = useTracked([(s) => s.clusters]);
  const st = useMailStore.getState();
  const payload = { cluster_id: c._id, account_id: c.account_id };
  const theme = c.kind === "theme";
  const live = Object.values(s.clusters).filter((x) => !x.deleted && x._id !== c._id && x.account_id === c.account_id).sort((a, b) => a.name.localeCompare(b.name));
  const peers = live.filter((x) => (x.kind === "theme") === theme);
  const dirty = name.trim() !== c.name || description.trim() !== c.description;
  // The server refuses a name another topic of the same kind already has;
  // say so here instead of letting the rename bounce silently.
  const clash = peers.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  const save = () => { if (clash) return; if (dirty && name.trim()) st.renameCluster({ ...payload, name: name.trim(), description: description.trim() }); close(); };
  // Inside the topic's own view, merging or dissolving it leaves nothing to
  // look at: follow the mail to where it went.
  const leave = (view: string) => { if (useMailStore.getState().activeView === `cluster:${c._id}`) st.setView(view as never); };
  const merge = () => { const target = s.clusters[into]; st.mergeClusters({ from_ids: [c._id], into_id: into, account_id: c.account_id }); st.pushToast(`Merged ${c.name} into ${target?.name ?? "the topic"}`); close(); leave(`cluster:${into}`); };
  const dissolve = () => { st.dissolveCluster(payload); st.pushToast(`Took ${c.name} apart — its conversations stay in the inbox`); close(); leave("inbox"); };
  return <div className="topic-editor" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }}>
    <label>Name<input value={name} maxLength={48} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }} /></label>
    <label>What belongs here<textarea value={description} maxLength={240} placeholder="One sentence Whisk reads to decide what joins this topic later." onChange={(e) => setDescription(e.target.value)} /></label>
    <div className="topic-actions">
      <button className="settings-btn is-primary" disabled={!name.trim() || !!clash} onClick={save}>{dirty ? "Save" : "Done"}</button>
      {clash && <span className="topic-error is-inline">Another topic is already called “{clash.name}” — merge into it instead.</span>}
      <button className="settings-btn is-quiet" onClick={close}>Cancel</button>
      {peers.length > 0 && <span className="topic-merge"><select aria-label="Merge into" value={into} onChange={(e) => setInto(e.target.value)}><option value="">Merge into…</option>{peers.map((x) => <option key={x._id} value={x._id}>{x.name}</option>)}</select>{into && <button className="settings-btn" onClick={merge}>Merge</button>}</span>}
      {confirming
        ? <span className="topic-confirm"><span>Take this topic apart? Its conversations stay in the inbox.</span><button className="settings-btn is-danger" onClick={dissolve}>Take apart</button><button className="settings-btn is-quiet" onClick={() => setConfirming(false)}>Keep</button></span>
        : <button className="settings-btn is-quiet" onClick={() => setConfirming(true)}>Take apart</button>}
    </div>
    <p className="settings-note">Whisk remembers the name and the sentence, and never regroups what you named. To move conversations, select them and press <KeyCap spec="T" />.</p>
  </div>;
}
