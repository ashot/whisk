import * as fs from "fs";
import * as path from "path";
import { api } from "@mail/convex/convex/_generated/api";
import type { OutgoingAttachment } from "@mail/shared/src/store/types";
import { checkOutgoingSize } from "@mail/shared/src/lib/attachments";
import { mutation } from "./client";

// Files on the way out. Bytes go to storage through a short-lived upload
// URL; the send or draft then names the storage id, and the pump reads the
// bytes when the message leaves.

/** Upload local files; the references a send or draft carries. */
export async function uploadFiles(paths: readonly string[]): Promise<OutgoingAttachment[]> {
  const files = paths.map((p) => {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`No such file: ${p}`);
    return { path: p, size: fs.statSync(p).size };
  });
  checkOutgoingSize(files);
  const out: OutgoingAttachment[] = [];
  for (const f of files) {
    const mime = Bun.file(f.path).type.split(";")[0].trim() || "application/octet-stream";
    const url = await mutation(api.gmail.attachments.uploadUrl, {});
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": mime }, body: fs.readFileSync(f.path) });
    if (!response.ok) throw new Error(`Upload of ${f.path} failed: ${response.status} ${await response.text()}`);
    const { storageId } = (await response.json()) as { storageId: string };
    out.push({ filename: path.basename(f.path), mime_type: mime, size: f.size, storage_id: storageId });
  }
  return out;
}

export function describeFiles(files: readonly OutgoingAttachment[] | undefined): string {
  if (!files?.length) return "";
  return `, ${files.length} file${files.length === 1 ? "" : "s"}`;
}
