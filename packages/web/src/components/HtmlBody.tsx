import React, { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { PALETTE } from "@platform/design";
import { attachmentUrl } from "../sync/ConvexSync";
import { splitQuotedHtml } from "../lib/quotedHtml";
import { QuotedFold } from "./QuotedFold";
import { currentTheme, useTheme } from "../lib/theme";
import { adaptToTheme } from "../lib/mailTheme";
import { lostImageCss, watchLostImages } from "../lib/lostImages";

// HTML mail renders inside a sandboxed iframe: scripts are stripped by
// DOMPurify AND the sandbox has no allow-scripts, so allow-same-origin is safe
// (nothing executable remains that could reach the parent) — and same-origin
// is what lets us measure the document for auto-height. The frame is sized to
// its content and never scrolls itself; the thread column scrolls.

function themeCss(quoted = false): string {
  // The iframe is a separate document — it inherits nothing. Feed it the
  // current theme's ink/link colors so plain HTML mail reads natively; mail
  // that paints its own backgrounds keeps them.
  // The frame only composites transparently when its color-scheme matches the
  // embedding page; a mismatch makes the browser paint an opaque white canvas
  // behind the mail no matter what the CSS backgrounds say.
  const scheme = currentTheme();
  // Before the stylesheet lands the properties read empty: fall back to the
  // family palette they come from.
  const styles = getComputedStyle(document.documentElement);
  const palette = PALETTE[scheme];
  const ink = styles.getPropertyValue("--m-ink").trim() || palette.ink;
  const muted = styles.getPropertyValue("--m-ink-muted").trim() || palette.inkMuted;
  const accent = styles.getPropertyValue("--m-accent").trim() || palette.accent;
  const rule = styles.getPropertyValue("--m-rule-strong").trim() || palette.ruleStrong;
  return `
  html { color-scheme: ${scheme}; }
  html, body {
    margin: 0; padding: 0;
    background: transparent;
    overflow: hidden;
  }
  body {
    font-family: "Newsreader Variable", Georgia, serif;
    font-size: 16px; line-height: 1.55; color: ${quoted ? muted : ink};
    overflow-wrap: break-word;
  }
  img { max-width: 100%; height: auto; }
  ${lostImageCss(rule, muted)}
  a { color: ${accent}; }
  blockquote { margin: 0; padding-left: 0.75em; border-left: 2px solid ${rule}; color: ${muted}; }
  pre { white-space: pre-wrap; }
  table { max-width: 100%; }
  `;
}

/** Inline images arrive as cid: references to MIME parts of the same message;
 *  point them at the attachment endpoint, which resolves the part by id. */
function resolveCidImages(root: Document, messageGmailId: string): void {
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    if (!src.toLowerCase().startsWith("cid:")) continue;
    const url = attachmentUrl(messageGmailId, { cid: src.slice(4) });
    if (url) img.setAttribute("src", url);
    else img.removeAttribute("src");
  }
}

/** A sanitized mail body as a complete frame document, themed and fenced.
 *  A quoted trail reads in muted ink: present, but not the message. */
function frameDoc(body: string, quoted = false): string {
  // Belt-and-suspenders CSP: no script can run; images may load (that is the
  // point of a mail body), nothing else may fetch.
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data:;`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${themeCss(quoted)}</style></head><body>${body}</body></html>`;
}

/** One sandboxed, content-sized frame. */
function MailFrame({ doc }: { doc: string }): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState(80);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return (
    <iframe
      ref={iframeRef}
      className="html-frame"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      style={{ height }}
      title="message"
      onLoad={() => {
        const inner = iframeRef.current?.contentDocument;
        const body = inner?.body;
        if (!body) return;
        // Track the content, not the load event: images arriving later
        // (they load by default) keep the frame exactly content-sized, so
        // the message can never scroll inside itself.
        const root = inner!.documentElement;
        const measure = () => {
          // Mail laid out for a fixed width (the 600px newsletter) scales
          // down to fit a narrow column, as a phone's mail app does, instead
          // of being cut off at the frame's edge. The zoom comes from the
          // natural width (read with the zoom off, in the same frame), so
          // applying it cannot feed back into itself.
          body.style.zoom = "";
          const fit = root.clientWidth / body.scrollWidth;
          if (fit < 0.99) body.style.zoom = String(fit);
          const tall = body.style.zoom ? body.getBoundingClientRect().height : body.scrollHeight;
          setHeight(Math.max(Math.ceil(tall) + 8, 24));
        };
        measure();
        observerRef.current?.disconnect();
        observerRef.current = new ResizeObserver(measure);
        observerRef.current.observe(body);
        // An image the sender's host no longer serves leaves the faded-photo
        // mark in its place; the ResizeObserver above reflows the frame.
        watchLostImages(inner!);
        // A click into the mail moves focus into this frame's own document,
        // whose keys never reach the app's shortcut listener. Hand each one
        // to the app window so shortcuts work wherever the reader clicked.
        inner!.addEventListener("keydown", (e) => {
          const { key, code, metaKey, ctrlKey, altKey, shiftKey, repeat } = e;
          const forwarded = new KeyboardEvent("keydown", { key, code, metaKey, ctrlKey, altKey, shiftKey, repeat, bubbles: true, cancelable: true });
          window.dispatchEvent(forwarded);
          if (forwarded.defaultPrevented) e.preventDefault();
        });
        // Links escape the frame into a new tab, never navigate the app.
        for (const a of Array.from(inner!.querySelectorAll("a"))) {
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noreferrer noopener");
        }
      }}
    />
  );
}

export function HtmlBody({
  html,
  messageGmailId,
}: {
  html: string;
  messageGmailId: string;
}): React.ReactElement {
  // The frame bakes the theme's colors into its own document, so a theme flip
  // has to rebuild it.
  const theme = useTheme();
  const { fresh, quote } = useMemo(() => {
    // Sanitize to a DOM (not a string) so the cid: and quote passes can walk it.
    const purified = DOMPurify.sanitize(html, {
      FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "base", "meta", "link", "style"],
      FORBID_ATTR: ["onerror", "onload", "onclick"],
      RETURN_DOM: true,
      WHOLE_DOCUMENT: false,
    }) as unknown as HTMLElement;
    const holder = document.implementation.createHTMLDocument("");
    holder.body.appendChild(holder.importNode(purified, true));
    resolveCidImages(holder, messageGmailId);
    adaptToTheme(holder, theme, getComputedStyle(document.documentElement).getPropertyValue("--m-bg"));
    const quote = splitQuotedHtml(holder);
    return { fresh: frameDoc(holder.body.innerHTML), quote };
  }, [html, messageGmailId, theme]);

  return (
    <div className="html-body">
      <MailFrame doc={fresh} />
      {quote && (
        <QuotedFold attribution={quote.attribution} count={quote.count}>
          {() => <MailFrame doc={frameDoc(quote.quotedHtml, true)} />}
        </QuotedFold>
      )}
    </div>
  );
}
