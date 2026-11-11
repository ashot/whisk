import React from "react";
import { useMailStore } from "../store/mailStore";
import type { Cluster } from "../store/types";
import { KeyCap } from "./KeyCap";
import { PopMenu } from "./PopMenu";
import { LensMenuItems } from "./Lenses";

/** Right-click on a topic (or the section of mail no topic claimed): hide
 *  or unhide it, and place all of its inbox mail in the views. */
export function TopicMenu({ cluster, x, y, onClose, threadIds }: { cluster?: Cluster; x: number; y: number; onClose: () => void; threadIds?: string[] }): React.ReactElement {
  return (
    <PopMenu x={x} y={y} onClose={onClose}>
      {cluster && (
        <button
          role="menuitem"
          autoFocus
          onClick={() => { onClose(); useMailStore.getState().hideTopic(cluster._id); }}
        >
          {cluster.hidden ? "Unhide" : "Hide"}
          <KeyCap spec="h" />
        </button>
      )}
      {threadIds && threadIds.length > 0 && <LensMenuItems ids={threadIds} onDone={onClose} />}
    </PopMenu>
  );
}
