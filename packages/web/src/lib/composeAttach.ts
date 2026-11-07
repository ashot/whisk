import { useSyncExternalStore } from "react";
import { checkOutgoingSize, outgoingKey, previewKind } from "@mail/shared/src/lib/attachments";
import type { OutgoingAttachment } from "@mail/shared/src/store/types";
import { mailStore } from "../store/mailStore";

// Files on a compose. Bytes go to Convex storage; the draft then names the
// storage id. Pending rows live here (not on the draft) until the upload
// lands, so a half-finished attach cannot be echoed off the server.

export type PendingComposeFile = {
  local_id: string;
  filename: string;
  mime_type: string;
  size: number;
  status: "uploading" | "error";
  preview_url?: string;
  error?: string;
};

type InternalPending = PendingComposeFile & { file: File };

const EMPTY: PendingComposeFile[] = [];
const pending = new Map<string, InternalPending[]>();
const aborts = new Map<string, AbortController>();
const previews = new Map<string, string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function subscribeComposePending(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getComposePending(draftId: string): PendingComposeFile[] {
  return pending.get(draftId) ?? EMPTY;
}

export function getComposePreview(key: string): string | undefined {
  return previews.get(key);
}

export function useComposePending(draftId: string): PendingComposeFile[] {
  return useSyncExternalStore(subscribeComposePending, () => getComposePending(draftId), () => EMPTY);
}

type Uploader = (file: File, signal: AbortSignal) => Promise<OutgoingAttachment>;

let uploader: Uploader = defaultUpload;
let watching = false;

export function setOutgoingUploader(fn: Uploader | null): void {
  uploader = fn ?? defaultUpload;
}

export function resetComposeAttachForTests(): void {
  for (const id of [...pending.keys()]) clearDraft(id);
  uploader = defaultUpload;
}

function watchDrafts(): void {
  if (watching) return;
  watching = true;
  mailStore.subscribe((s) => {
    for (const id of [...pending.keys()]) {
      if (!s.drafts[id]) clearDraft(id);
    }
  });
}

async function defaultUpload(file: File, signal: AbortSignal): Promise<OutgoingAttachment> {
  const { convexClient } = await import("../sync/ConvexSync");
  const { api } = await import("@mail/convex/convex/_generated/api");
  const token = mailStore.getState().authToken ?? undefined;
  const mime = file.type.split(";")[0].trim() || "application/octet-stream";
  const url = await convexClient().mutation(api.gmail.attachments.uploadUrl, token ? { token } : {});
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": mime },
    body: file,
    signal,
  });
  if (!response.ok) throw new Error(`Could not attach ${file.name}`);
  const { storageId } = (await response.json()) as { storageId?: string };
  if (!storageId) throw new Error(`Could not attach ${file.name}`);
  return { filename: file.name, mime_type: mime, size: file.size, storage_id: storageId };
}

type FileEntry = { isDirectory: boolean };

function asEntry(item: DataTransferItem): FileEntry | null {
  const fn = (item as DataTransferItem & { webkitGetAsEntry?: () => FileEntry | null }).webkitGetAsEntry;
  return fn ? fn.call(item) : null;
}

/** True when the drag is files, not text or a UI chip. */
export function dataTransferHasFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  const types = [...dt.types];
  return types.includes("Files") || types.includes("application/x-moz-file");
}

export function filesFromDataTransfer(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const fromItems: File[] = [];
  if (dt.items && dt.items.length > 0) {
    for (const item of dt.items) {
      if (item.kind !== "file") continue;
      const entry = asEntry(item);
      if (entry?.isDirectory) continue;
      const f = item.getAsFile();
      if (f) fromItems.push(f);
    }
    // Items were present: a directory-only drop must not fall through to
    // `files`, which still lists the folder as a zero-byte File.
    return fromItems;
  }
  return [...dt.files];
}

function ensureDraft(): string | null {
  const s = mailStore.getState();
  if (s.composeDraftId) {
    if (s.composeMinimized) s.minimizeCompose(false);
    return s.composeDraftId;
  }
  const t = s.openThreadId ? s.threads[s.openThreadId] : null;
  if (t) s.startCompose("reply", t.gmail_id);
  else s.startCompose("new");
  return mailStore.getState().composeDraftId;
}

function setPending(draftId: string, next: InternalPending[]): void {
  if (next.length === 0) pending.delete(draftId);
  else pending.set(draftId, next);
  notify();
}

function clearDraft(draftId: string): void {
  const rows = pending.get(draftId) ?? [];
  for (const row of rows) {
    aborts.get(row.local_id)?.abort();
    aborts.delete(row.local_id);
    if (row.preview_url) URL.revokeObjectURL(row.preview_url);
  }
  pending.delete(draftId);
  notify();
}

function previewFor(file: File): string | undefined {
  if (previewKind({ mime_type: file.type, filename: file.name }) !== "image") return undefined;
  return URL.createObjectURL(file);
}

export async function attachToCompose(files: readonly File[]): Promise<void> {
  if (files.length === 0) return;
  watchDrafts();
  const draftId = ensureDraft();
  if (!draftId) return;
  const s = mailStore.getState();
  const draft = s.drafts[draftId];
  if (!draft) return;
  const current = [...(draft.attachments ?? []), ...getComposePending(draftId), ...files];
  try {
    checkOutgoingSize(current);
  } catch (e) {
    s.pushToast(e instanceof Error ? e.message : String(e), "error");
    return;
  }
  const added: InternalPending[] = files.map((file) => ({
    local_id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    filename: file.name,
    mime_type: file.type.split(";")[0].trim() || "application/octet-stream",
    size: file.size,
    status: "uploading" as const,
    preview_url: previewFor(file),
    file,
  }));
  setPending(draftId, [...(pending.get(draftId) ?? []), ...added]);
  await Promise.all(added.map((row) => uploadOne(draftId, row)));
}

async function uploadOne(draftId: string, row: InternalPending): Promise<void> {
  const ac = new AbortController();
  aborts.set(row.local_id, ac);
  try {
    const out = await uploader(row.file, ac.signal);
    if (row.preview_url) previews.set(outgoingKey(out), row.preview_url);
    const rest = (pending.get(draftId) ?? []).filter((p) => p.local_id !== row.local_id);
    setPending(draftId, rest);
    const current = mailStore.getState().drafts[draftId];
    if (!current) return;
    // Re-read so two uploads finishing in adjacent microtasks both land.
    const latest = mailStore.getState().drafts[draftId];
    mailStore.getState().updateComposeDraft({
      attachments: [...(latest?.attachments ?? []), out],
    });
  } catch (e) {
    if (ac.signal.aborted) {
      const rest = (pending.get(draftId) ?? []).filter((p) => p.local_id !== row.local_id);
      setPending(draftId, rest);
      if (row.preview_url) URL.revokeObjectURL(row.preview_url);
      return;
    }
    const rows = pending.get(draftId) ?? [];
    setPending(
      draftId,
      rows.map((p) =>
        p.local_id === row.local_id
          ? { ...p, status: "error", error: e instanceof Error ? e.message : String(e) }
          : p,
      ),
    );
  } finally {
    aborts.delete(row.local_id);
  }
}

export function removeComposeFile(draftId: string, key: string): void {
  const row = (pending.get(draftId) ?? []).find((p) => p.local_id === key);
  if (row) {
    aborts.get(row.local_id)?.abort();
    aborts.delete(row.local_id);
    if (row.preview_url) URL.revokeObjectURL(row.preview_url);
    setPending(
      draftId,
      (pending.get(draftId) ?? []).filter((p) => p.local_id !== key),
    );
    return;
  }
  const d = mailStore.getState().drafts[draftId];
  if (!d) return;
  mailStore.getState().updateComposeDraft({
    attachments: (d.attachments ?? []).filter((f) => outgoingKey(f) !== key),
  });
  const url = previews.get(key);
  if (url) {
    URL.revokeObjectURL(url);
    previews.delete(key);
  }
}

export function retryComposeFile(draftId: string, localId: string): void {
  const row = (pending.get(draftId) ?? []).find((p) => p.local_id === localId);
  if (!row || row.status !== "error") return;
  setPending(
    draftId,
    (pending.get(draftId) ?? []).map((p) => (p.local_id === localId ? { ...p, status: "uploading", error: undefined } : p)),
  );
  void uploadOne(draftId, row);
}

function waitUntilIdle(draftId: string): Promise<void> {
  if (getComposePending(draftId).every((p) => p.status !== "uploading")) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = subscribeComposePending(() => {
      if (getComposePending(draftId).every((p) => p.status !== "uploading")) {
        unsub();
        resolve();
      }
    });
  });
}

/** Send once in-flight uploads land. A failed file blocks the send. */
export async function sendComposeReady(): Promise<void> {
  const id = mailStore.getState().composeDraftId;
  if (!id) return;
  if (getComposePending(id).some((p) => p.status === "uploading")) {
    mailStore.getState().pushToast("Attaching files…");
    await waitUntilIdle(id);
  }
  if (getComposePending(id).some((p) => p.status === "error")) {
    mailStore.getState().pushToast("A file failed to attach — remove it or try again", "error");
    return;
  }
  mailStore.getState().sendCompose();
}

export function handleComposePaste(e: { clipboardData: DataTransfer | null; preventDefault: () => void }): void {
  const files = filesFromDataTransfer(e.clipboardData);
  if (files.length === 0) return;
  const text = e.clipboardData?.getData("text/plain") ?? "";
  if (!text) e.preventDefault();
  void attachToCompose(files);
}
