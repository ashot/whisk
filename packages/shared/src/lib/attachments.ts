import type { Attachment, Message, OutgoingAttachment } from "../store/types";

// What the reader can do with a file, decided from its type alone, so the
// web, the desktop and the CLI agree on which files preview inline.

export type PreviewKind = "image" | "pdf" | "text" | "none";

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-sh))/;
const TEXT_EXT = /\.(txt|md|csv|log|json|xml|yml|yaml|ics|js|ts|py|sh|html?)$/i;

export function previewKind(a: Pick<Attachment, "mime_type" | "filename">): PreviewKind {
  const mime = a.mime_type.split(";")[0].trim().toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp|bmp|x-icon|vnd\.microsoft\.icon)$/.test(mime)) return "image";
  if (mime === "application/pdf" || /\.pdf$/i.test(a.filename)) return "pdf";
  if (TEXT_TYPES.test(mime) || (mime === "application/octet-stream" && TEXT_EXT.test(a.filename))) return "text";
  return "none";
}

/** Files up to this size come down as soon as the conversation opens; bigger
 *  ones wait for a click. */
export const PRELOAD_MAX_BYTES = 25 * 1024 * 1024;

export function attachmentKey(m: Pick<Message, "gmail_id">, a: Pick<Attachment, "gmail_attachment_id">): string {
  return `${m.gmail_id}/${a.gmail_attachment_id}`;
}

/** Gmail caps a message at 25 MB of files; the pump would only learn that
 *  from a rejected send, so every client checks before queueing. */
export const OUTGOING_MAX_BYTES = 25 * 1024 * 1024;

export function checkOutgoingSize(files: readonly Pick<OutgoingAttachment, "size">[]): void {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > OUTGOING_MAX_BYTES) {
    throw new Error(`Files total ${Math.round(total / 1024 / 1024)} MB; Gmail allows 25 MB per message`);
  }
}

/** The shape a sent message's row carries for files that have not reached
 *  Gmail yet: the metadata is known, the Gmail attachment id is not, so it
 *  is empty until the synced message replaces the stub. */
export function outgoingAsAttachments(files: readonly OutgoingAttachment[] | undefined): Attachment[] {
  return (files ?? []).map((f) => ({
    filename: f.filename,
    mime_type: f.mime_type,
    size: f.size,
    gmail_attachment_id: f.gmail_attachment_id ?? "",
  }));
}

/** The files of a message, as inputs to a new message that forwards them. */
export function forwardedAttachments(m: Pick<Message, "gmail_id" | "attachments">): OutgoingAttachment[] {
  return m.attachments.map((a) => ({
    filename: a.filename,
    mime_type: a.mime_type,
    size: a.size,
    message_gmail_id: m.gmail_id,
    gmail_attachment_id: a.gmail_attachment_id,
  }));
}

/** Stable identity for a file on a draft: an upload, or a forwarded part. */
export function outgoingKey(f: Pick<OutgoingAttachment, "storage_id" | "message_gmail_id" | "gmail_attachment_id" | "filename" | "size">): string {
  if (f.storage_id) return `s:${f.storage_id}`;
  if (f.message_gmail_id && f.gmail_attachment_id) return `g:${f.message_gmail_id}/${f.gmail_attachment_id}`;
  return `n:${f.filename}:${f.size}`;
}
