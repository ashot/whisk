import React, { useId, useState } from "react";
import type { QuoteAttribution } from "@mail/shared/src/lib/quotes";
import { relativeDate } from "../lib/format";

/** The earlier messages a reply quotes, folded to one quiet line: who and
 *  when, and a stack that grows with how deep the trail runs. The trail
 *  itself only renders once opened. */
export function QuotedFold({
  attribution,
  count,
  children,
}: {
  attribution: QuoteAttribution | null;
  count: number;
  children: () => React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const id = useId();
  const more = count - 1;
  const noun = count === 1 ? "earlier message" : "earlier messages";
  return (
    <div className={`quote-fold${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="quote-toggle"
        aria-expanded={open}
        aria-controls={id}
        title={open ? "Hide quoted text" : `Show quoted text (${count} ${noun})`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="quote-chip" data-depth={Math.min(count, 3)} aria-hidden>
          <i />
          <i />
          <i />
        </span>
        {open ? (
          <span className="quote-who">Hide quoted text</span>
        ) : (
          <>
            {attribution?.name && <span className="quote-who">{attribution.name}</span>}
            {attribution?.date && <span className="quote-when">{relativeDate(attribution.date)}</span>}
            {!attribution?.name && <span className="quote-who">Quoted text</span>}
            {more > 0 && <span className="quote-more">+{more}</span>}
          </>
        )}
      </button>
      {open && (
        <div id={id} className="quote-trail">
          {children()}
        </div>
      )}
    </div>
  );
}
