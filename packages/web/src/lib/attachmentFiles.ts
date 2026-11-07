import { useSyncExternalStore } from "react";
import type { Attachment, Message } from "../store/types";
import { attachmentKey, PRELOAD_MAX_BYTES } from "@mail/shared/src/lib/attachments";
import { attachmentUrl } from "../sync/ConvexSync";
import { desktopBridge } from "./desktopBridge";

// Files on disk. In the desktop shell every attachment of an open
// conversation comes down to one flat folder (~/Downloads/Whisk) as soon as
// the conversation opens, so a click shows it at once and Finder can reveal it.
// In a browser nothing is written; previews fetch on demand instead.

export type FileState =
  | { status: "pending" }
  | { status: "ready"; path: string; size: number }
  | { status: "error"; error: string };

const files = new Map<string, FileState>();
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<string | null>>();

function publish(key: string, state: FileState): void {
  files.set(key, state);
  for (const l of listeners) l();
}

export function useAttachmentFile(key: string): FileState | undefined {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => files.get(key),
  );
}

/** Whether files can land on disk here at all. */
export function canStoreFiles(): boolean {
  return !!desktopBridge();
}

/** The message's file on disk, downloading it first when needed. Resolves the
 *  path, or null in a browser or on failure. Concurrent calls share one
 *  download. */
export function ensureLocal(m: Message, a: Attachment): Promise<string | null> {
  const bridge = desktopBridge();
  const key = attachmentKey(m, a);
  const known = files.get(key);
  if (known?.status === "ready") return Promise.resolve(known.path);
  const url = attachmentUrl(m.gmail_id, { attachment: a });
  if (!bridge || !url) return Promise.resolve(null);
  const running = inflight.get(key);
  if (running) return running;
  publish(key, { status: "pending" });
  const p = bridge
    .call("attachment-fetch", { url, name: a.filename, size: a.size })
    .then((r: { path: string; size: number }) => {
      publish(key, { status: "ready", path: r.path, size: r.size });
      return r.path;
    })
    .catch((e: unknown) => {
      publish(key, { status: "error", error: e instanceof Error ? e.message : String(e) });
      return null;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Bring down every file of these messages that is small enough to fetch
 *  unasked. */
export function preloadAttachments(messages: readonly Message[]): void {
  if (!canStoreFiles()) return;
  for (const m of messages) {
    for (const a of m.attachments) if (a.size <= PRELOAD_MAX_BYTES) void ensureLocal(m, a);
  }
}

export function revealInFinder(path: string): void {
  void desktopBridge()?.call("attachment-reveal", path);
}

export function openWithDefaultApp(path: string): void {
  void desktopBridge()?.call("attachment-open", path);
}

/** macOS Quick Look over the window. */
export function quickLook(path: string, name: string): void {
  void desktopBridge()?.call("attachment-quicklook", path, name);
}

// Bytes for the in-app viewer, as blob: URLs the page can put in an <img>,
// an <iframe> or a text pane. From disk on the desktop, over the network in
// a browser. One URL per file for the life of the page.
const blobUrls = new Map<string, Promise<string>>();

export function previewUrl(m: Message, a: Attachment): Promise<string> {
  const key = attachmentKey(m, a);
  let p = blobUrls.get(key);
  if (p) return p;
  p = (async () => {
    const bridge = desktopBridge();
    let bytes: ArrayBuffer | Uint8Array;
    if (bridge) {
      const path = await ensureLocal(m, a);
      if (!path) throw new Error("download failed");
      bytes = await bridge.call("attachment-read", path);
    } else {
      const url = attachmentUrl(m.gmail_id, { attachment: a });
      if (!url) throw new Error("not signed in");
      // Past the HTTP cache: the <img> thumbnail fetched this same URL with
      // no Origin, and a cached copy without the CORS grant fails here.
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      bytes = await res.arrayBuffer();
    }
    const type = a.mime_type.split(";")[0].trim().toLowerCase() || "application/octet-stream";
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  })();
  p.catch(() => blobUrls.delete(key));
  blobUrls.set(key, p);
  return p;
}
