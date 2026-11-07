import React, { useEffect, useRef, useState } from "react";
import { useMailStore, useTracked } from "../store/mailStore";
import type { Attachment, Message } from "../store/types";
import { attachmentKey, previewKind } from "@mail/shared/src/lib/attachments";
import { formatSize } from "../lib/format";
import { attachmentUrl } from "../sync/ConvexSync";
import {
  canStoreFiles,
  ensureLocal,
  openWithDefaultApp,
  previewUrl,
  quickLook,
  revealInFinder,
  useAttachmentFile,
} from "../lib/attachmentFiles";
import { KeyCap } from "./KeyCap";

function extension(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toUpperCase() : "FILE";
}

/** Whether a click on this file can show something in the app. Files with
 *  no in-app preview still open the viewer on the desktop, where Quick Look
 *  and Finder sit behind it. */
function viewable(a: Attachment): boolean {
  return previewKind(a) !== "none" || canStoreFiles();
}

function Chip({ m, a, index }: { m: Message; a: Attachment; index: number }): React.ReactElement {
  const st = useMailStore.getState();
  const file = useAttachmentFile(attachmentKey(m, a));
  const kind = previewKind(a);
  const href = attachmentUrl(m.gmail_id, { attachment: a });
  const desktop = canStoreFiles();
  const state = file?.status ?? (desktop ? "idle" : "web");
  const open = () => {
    if (viewable(a)) st.openAttachment(m.gmail_id, index);
    else if (href) window.open(href, "_blank", "noopener");
  };
  return (
    <div className={`attachment-chip is-${state}`} title={a.mime_type}>
      <button className="attachment-main" onClick={open} tabIndex={-1}>
        {kind === "image" && href ? (
          <img className="attachment-thumb" src={href} alt="" loading="lazy" />
        ) : (
          <span className="attachment-glyph" data-kind={kind}>
            {extension(a.filename)}
          </span>
        )}
        <span className="attachment-text">
          <span className="attachment-name">{a.filename}</span>
          <span className="attachment-size">
            {formatSize(a.size)}
            {state === "pending" && <span className="attachment-dot" aria-label="downloading" />}
            {state === "error" && <span className="attachment-err">not saved</span>}
          </span>
        </span>
      </button>
      {desktop ? (
        <button
          className="attachment-action"
          tabIndex={-1}
          title="Show in Finder"
          onClick={async () => {
            const path = file?.status === "ready" ? file.path : await ensureLocal(m, a);
            if (path) revealInFinder(path);
          }}
        >
          Finder
        </button>
      ) : (
        href && (
          <a className="attachment-action" href={href} download={a.filename} tabIndex={-1} title="Download">
            ↓
          </a>
        )
      )}
    </div>
  );
}

export function AttachmentChips({ m }: { m: Message }): React.ReactElement | null {
  if (m.attachments.length === 0) return null;
  return (
    <footer className="msg-attachments">
      {m.attachments.map((a, i) => (
        <Chip key={a.gmail_attachment_id || i} m={m} a={a} index={i} />
      ))}
    </footer>
  );
}

function Pane({ m, a }: { m: Message; a: Attachment }): React.ReactElement {
  const kind = previewKind(a);
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    setText(null);
    setError(null);
    if (kind === "none") return;
    let live = true;
    previewUrl(m, a)
      .then(async (u) => {
        if (!live) return;
        if (kind === "text") setText(await (await fetch(u)).text());
        setUrl(u);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [m.gmail_id, a.gmail_attachment_id]);

  if (error) return <div className="viewer-empty">Could not load this file. {error}</div>;
  if (kind === "none")
    return (
      <div className="viewer-empty">
        <span className="attachment-glyph is-large" data-kind="none">
          {extension(a.filename)}
        </span>
        No preview for this kind of file.
        {canStoreFiles() && (
          <span className="viewer-empty-hint">
            <KeyCap spec="space" /> Quick Look · <KeyCap spec="o" /> open
          </span>
        )}
      </div>
    );
  if (!url) return <div className="viewer-loading" aria-label="loading" />;
  if (kind === "image") return <img className="viewer-image" src={url} alt={a.filename} />;
  if (kind === "pdf")
    return (
      <iframe
        className="viewer-frame"
        src={`${url}#toolbar=0`}
        title={a.filename}
        // The PDF plugin takes focus as it loads; take it back so Escape
        // and the arrows keep working.
        onLoad={() => document.querySelector<HTMLElement>(".viewer")?.focus()}
      />
    );
  return <pre className="viewer-text">{text}</pre>;
}

/** The file viewer: one file at a time over the conversation, arrows to move
 *  through every file in it. On the desktop the file is already on disk, so
 *  Finder, Quick Look and the default app are one key away. */
export function AttachmentViewer(): React.ReactElement | null {
  const s = useTracked([
    (s) => s.attachmentViewer,
    (s) => (s.openThreadId ? s.threads[s.openThreadId] : null),
    (s) => {
      const t = s.openThreadId ? s.threads[s.openThreadId] : null;
      return t ? s.threadMessages[t.gmail_id] : null;
    },
  ]);
  const st = useMailStore.getState();
  const root = useRef<HTMLDivElement>(null);
  const v = s.attachmentViewer;
  const t = s.openThreadId ? s.threads[s.openThreadId] : null;
  const msgs = t ? (s.threadMessages[t.gmail_id] ?? []) : [];
  const m = v ? msgs.find((x) => x.gmail_id === v.messageGmailId) : undefined;
  const a = m && v ? m.attachments[v.index] : undefined;
  const file = useAttachmentFile(m && a ? attachmentKey(m, a) : "");
  const desktop = canStoreFiles();
  const href = m && a ? attachmentUrl(m.gmail_id, { attachment: a }) : null;
  const all = msgs.flatMap((x) => x.attachments.map((_, index) => ({ id: x.gmail_id, index })));
  const at = v ? all.findIndex((f) => f.id === v.messageGmailId && f.index === v.index) : -1;

  const withPath = async (fn: (path: string) => void) => {
    if (!m || !a) return;
    const path = file?.status === "ready" ? file.path : await ensureLocal(m, a);
    if (path) fn(path);
  };

  useEffect(() => {
    // Keys must reach this window, not a PDF frame that took focus on load.
    root.current?.focus();
  }, [v?.messageGmailId, v?.index]);

  useEffect(() => {
    if (!v) return;
    // The viewer is modal: while it is up, its keys are the only keys. The
    // capture listener runs before the app's key engine and stops the event
    // there, so j never moves the list and e never archives underneath it.
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      switch (e.key) {
        case "Escape":
          st.closeAttachment();
          break;
        case "ArrowRight":
        case "j":
        case "n":
          st.moveAttachment(1);
          break;
        case "ArrowLeft":
        case "k":
        case "p":
          st.moveAttachment(-1);
          break;
        case " ":
          if (desktop) void withPath((p) => quickLook(p, a?.filename ?? ""));
          break;
        case "f":
          if (desktop) void withPath(revealInFinder);
          break;
        case "o":
          if (desktop) void withPath(openWithDefaultApp);
          else if (href) window.open(href, "_blank", "noopener");
          break;
        case "d":
          if (href) window.open(href, "_blank", "noopener");
          break;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [v?.messageGmailId, v?.index, file?.status, desktop, href]);

  if (!v || !m || !a) return null;
  return (
    <div
      ref={root}
      className="viewer"
      role="dialog"
      aria-label={a.filename}
      tabIndex={-1}
      onClick={() => st.closeAttachment()}
    >
      <header className="viewer-head" onClick={(e) => e.stopPropagation()}>
        <span className="viewer-title">
          <span className="viewer-name">{a.filename}</span>
          <span className="viewer-meta">
            {formatSize(a.size)}
            {all.length > 1 && ` · ${at + 1} of ${all.length}`}
            {file?.status === "pending" && " · saving…"}
          </span>
        </span>
        <span className="viewer-actions">
          {desktop ? (
            <>
              <button onClick={() => void withPath(revealInFinder)} title="Show in Finder (f)">
                Finder
              </button>
              <button onClick={() => void withPath(openWithDefaultApp)} title="Open with the default app (o)">
                Open
              </button>
            </>
          ) : (
            href && (
              <a href={href} download={a.filename} title="Download (d)">
                Download
              </a>
            )
          )}
          <button className="viewer-close" onClick={() => st.closeAttachment()} title="Close (esc)">
            ×
          </button>
        </span>
      </header>
      <div className="viewer-stage" onClick={(e) => e.stopPropagation()}>
        <Pane key={`${m.gmail_id}/${a.gmail_attachment_id}`} m={m} a={a} />
      </div>
      {at > 0 && (
        <button className="viewer-arrow is-prev" onClick={(e) => { e.stopPropagation(); st.moveAttachment(-1); }} title="Previous (←)">
          ‹
        </button>
      )}
      {at >= 0 && at < all.length - 1 && (
        <button className="viewer-arrow is-next" onClick={(e) => { e.stopPropagation(); st.moveAttachment(1); }} title="Next (→)">
          ›
        </button>
      )}
    </div>
  );
}
