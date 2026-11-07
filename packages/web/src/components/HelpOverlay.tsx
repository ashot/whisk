import React from "react";
import { keyEngine } from "../keys/engine";
import { useMailStore } from "../store/mailStore";
import { KeyCap } from "./KeyCap";
import { useRestoreFocus } from "../lib/useRestoreFocus";

const GROUP_ORDER = ["Navigate", "Go to", "Accounts", "Actions", "Topics", "Whisk", "Sweep", "Select", "Compose", "Search"];

export function HelpOverlay(): React.ReactElement {
  useRestoreFocus();
  const groups = new Map<string, { keys: string; description: string }[]>();
  for (const b of keyEngine.all()) {
    if (b.hidden) continue;
    const list = groups.get(b.group) ?? [];
    if (!list.some((x) => x.description === b.description)) {
      list.push({ keys: b.keys, description: b.description });
    }
    groups.set(b.group, list);
  }
  const ordered = GROUP_ORDER.filter((g) => groups.has(g));

  return (
    <div className="overlay" onClick={() => useMailStore.getState().setHelp(false)}>
      <div className="help" onClick={(e) => e.stopPropagation()}>
        <header className="help-head">
          <h2 className="help-title">Keyboard</h2>
          <span className="help-sub">
            everything here works without a mouse — <KeyCap spec="escape" /> closes
          </span>
        </header>
        <div className="help-columns">
          {ordered.map((g) => (
            <section key={g} className="help-group">
              <h3 className="help-group-title">{g}</h3>
              {groups.get(g)!.map((b) => (
                <div key={b.keys + b.description} className="help-row">
                  <KeyCap spec={b.keys} />
                  <span className="help-desc">{b.description}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
