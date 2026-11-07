import React from "react";
import { parseSpec, tokenParts } from "../keys/engine";
import { runKey } from "../keys/bindings";

/** Renders a key spec ("g i", "cmd+enter") as keycaps. The only way keys
 *  appear in the UI — never as bare text. */
export function KeyCap({ spec }: { spec: string }): React.ReactElement {
  const tokens = parseSpec(spec);
  return (
    <span className="keycaps">
      {tokens.map((t, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="keycap-then" aria-hidden />}
          <kbd className="keycap">{tokenParts(t).join("")}</kbd>
        </React.Fragment>
      ))}
    </span>
  );
}

/** A keycap and the verb it performs, bound tightly. Hint strips set a wider
 *  gap between pairs, so "e archive # trash" reads as two units, not four.
 *  A clickable pair is a button that runs the same binding as its keys. */
export function HintPair({
  spec,
  clickable,
  children,
}: {
  spec: string;
  clickable?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const inner = (
    <>
      <KeyCap spec={spec} />
      <span>{children}</span>
    </>
  );
  if (!clickable) return <span className="hint-pair">{inner}</span>;
  return (
    <button type="button" className="hint-pair is-button" onClick={() => runKey(spec)}>
      {inner}
    </button>
  );
}
