// The HTML half of quote folding: find where a reply's quoted trail begins
// and lift it out of the sanitized document. What counts as a quote header,
// who wrote it and whether it is a forward come from the shared rules.
import {
  isForwardHeader,
  parseAttribution,
  type QuoteAttribution,
} from "@mail/shared/src/lib/quotes";

export interface HtmlQuoteSplit {
  quotedHtml: string;
  attribution: QuoteAttribution | null;
  count: number;
}

// Containers each client wraps its quote in. Gmail's div.gmail_quote also
// covers .gmail_quote_container; Apple Mail and Thunderbird cite with
// blockquote[type=cite]; Outlook on the web opens with #divRplyFwdMsg.
const QUOTE_SELECTOR = [
  "div.gmail_quote",
  "blockquote.gmail_quote",
  "blockquote[type=cite]",
  "#divRplyFwdMsg",
  "div.OutlookMessageHeader",
  ".yahoo_quoted",
  ".protonmail_quote",
  "#mail-editor-reference-message-container",
].join(",");

const HEADER_START = /^(From|De|Von|Van|Da):\s/;
const ATTRIBUTION_END = /wrote:\s*$/;

function textOf(node: Node | null | undefined, max = 600): string {
  return (node?.textContent ?? "").replace(/[\s ]+/g, " ").trim().slice(0, max);
}

/** Every quote marker in document order: the known containers, plus desktop
 *  Outlook's header block (a top-bordered div that opens with "From:"). */
function quoteMarkers(doc: Document): Element[] {
  const found = Array.from(doc.body.querySelectorAll(QUOTE_SELECTOR)).filter(
    // Gmail nests blockquote.gmail_quote inside its div.gmail_quote: one quote.
    (el) => !(el.tagName === "BLOCKQUOTE" && el.parentElement?.matches("div.gmail_quote")),
  );
  for (const el of Array.from(doc.body.querySelectorAll("div[style*='border-top']"))) {
    if (HEADER_START.test(textOf(el, 40))) found.push(el);
  }
  return found.sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
}

function isBlank(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return !textOf(node);
  if (node.nodeType !== Node.ELEMENT_NODE) return true;
  const el = node as Element;
  return !textOf(el) && !el.matches("img, table, video, svg") && !el.querySelector("img, table, video, svg");
}

/** The node the fold begins at: the marker, pulled back over a rule or an
 *  "On … wrote:" line that sits just above it and belongs to the quote. */
function foldStart(marker: Element): Node {
  let start: Node = marker;
  for (let prev = marker.previousSibling; prev; prev = prev.previousSibling) {
    if (isBlank(prev) && (prev as Element).tagName !== "HR") continue;
    const el = prev as Element;
    if (el.tagName === "HR" || ATTRIBUTION_END.test(textOf(el))) start = prev;
    break;
  }
  // Outlook wraps its header block in a bare <div>; fold the wrapper, not
  // just the header, when the header is its first real content.
  let parent = (start as Element).parentElement;
  while (parent && parent !== start.ownerDocument!.body && firstContent(parent) === start) {
    start = parent;
    parent = parent.parentElement;
  }
  return start;
}

function firstContent(el: Element): Node | undefined {
  return Array.from(el.childNodes).find((n) => !isBlank(n) || (n as Element).tagName === "HR");
}

/** Drop blank paragraphs and breaks from one edge of the body. Outlook and
 *  Gmail pad both ends of a reply, which would otherwise sit as dead space
 *  above the message and above the fold. */
function trimBlankEdge(el: Element, edge: "firstChild" | "lastChild"): void {
  for (let node = el[edge]; node; node = el[edge]) {
    if (node.nodeType === Node.ELEMENT_NODE && !isBlank(node)) {
      trimBlankEdge(node as Element, edge);
      return;
    }
    if (!isBlank(node)) return;
    node.remove();
  }
}

/** Lift the quoted trail out of `doc` (mutating it to the new content) and
 *  return the trail as HTML. Null, with `doc` untouched, when there is no
 *  trail, when the message is a forward, or when nothing precedes the quote. */
export function splitQuotedHtml(doc: Document): HtmlQuoteSplit | null {
  const markers = quoteMarkers(doc);
  const first = markers[0];
  if (!first) return null;
  const start = foldStart(first);
  const header = `${textOf(start === first ? null : start)} ${textOf(first)}`;
  if (isForwardHeader(header)) return null;

  const range = doc.createRange();
  range.setStartBefore(start);
  range.setEndAfter(doc.body.lastChild!);
  const before = doc.createRange();
  before.setStart(doc.body, 0);
  before.setEndBefore(start);
  const lead = doc.createElement("div");
  lead.appendChild(before.cloneContents());
  if (isBlank(lead)) return null;

  // The fold draws its own spine; the outermost quote's rule would double it.
  const outer = first.matches("blockquote") ? first : first.querySelector(":scope > blockquote");
  outer?.setAttribute("style", "margin:0;padding:0;border:none");

  const quoted = doc.createElement("div");
  quoted.appendChild(range.extractContents());
  trimBlankEdge(doc.body, "firstChild");
  trimBlankEdge(doc.body, "lastChild");
  return {
    quotedHtml: quoted.innerHTML,
    attribution: parseAttribution(header),
    count: markers.length,
  };
}
