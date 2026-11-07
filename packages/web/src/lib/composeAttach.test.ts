import { afterEach, describe, expect, test } from "bun:test";
import { OUTGOING_MAX_BYTES } from "@mail/shared/src/lib/attachments";
import { mailStore } from "../store/mailStore";
import {
  attachToCompose,
  dataTransferHasFiles,
  filesFromDataTransfer,
  getComposePending,
  removeComposeFile,
  resetComposeAttachForTests,
  sendComposeReady,
  setOutgoingUploader,
} from "./composeAttach";

function file(name: string, body = "hello", type = "text/plain"): File {
  return new File([body], name, { type });
}

function dt(files: File[], types = ["Files"], extras?: { directory?: boolean }): DataTransfer {
  const items = files.map((f) => ({
    kind: "file" as const,
    type: f.type,
    getAsFile: () => f,
    webkitGetAsEntry: extras?.directory ? () => ({ isDirectory: true }) : () => ({ isDirectory: false }),
  }));
  return { files, types, items } as unknown as DataTransfer;
}

afterEach(() => {
  resetComposeAttachForTests();
  setOutgoingUploader(null);
  mailStore.setState({
    composeDraftId: null,
    composeMinimized: false,
    drafts: {},
    toasts: [],
    openThreadId: null,
    threads: {},
  });
});

test("a file drag is files; a text drag is not", () => {
  expect(dataTransferHasFiles(dt([file("a.txt")]))).toBe(true);
  expect(dataTransferHasFiles({ types: ["text/plain"], files: [], items: [] } as unknown as DataTransfer)).toBe(false);
  expect(dataTransferHasFiles(null)).toBe(false);
});

test("filesFromDataTransfer skips directories and reads the file list", () => {
  const a = file("a.txt");
  expect(filesFromDataTransfer(dt([a]))).toEqual([a]);
  expect(filesFromDataTransfer(dt([a], ["Files"], { directory: true }))).toEqual([]);
  expect(filesFromDataTransfer(null)).toEqual([]);
});

describe("attachToCompose", () => {
  test("uploads, then stores the file on the open draft", async () => {
    mailStore.getState().startCompose("new");
    const draftId = mailStore.getState().composeDraftId!;
    setOutgoingUploader(async (f) => ({
      filename: f.name,
      mime_type: f.type.split(";")[0].trim() || "application/octet-stream",
      size: f.size,
      storage_id: "st_1",
    }));
    await attachToCompose([file("note.txt", "hi")]);
    expect(getComposePending(draftId)).toEqual([]);
    expect(mailStore.getState().drafts[draftId].attachments).toEqual([
      { filename: "note.txt", mime_type: "text/plain", size: 2, storage_id: "st_1" },
    ]);
  });

  test("opens a new compose when none is open", async () => {
    setOutgoingUploader(async (f) => ({
      filename: f.name,
      mime_type: f.type || "application/octet-stream",
      size: f.size,
      storage_id: "st_2",
    }));
    await attachToCompose([file("pic.png", "xx", "image/png")]);
    const id = mailStore.getState().composeDraftId;
    expect(id).toBeTruthy();
    expect(mailStore.getState().drafts[id!].attachments?.[0].filename).toBe("pic.png");
  });

  test("refuses a drop that would go past Gmail's 25 MB cap", async () => {
    mailStore.getState().startCompose("new");
    const draftId = mailStore.getState().composeDraftId!;
    let uploaded = 0;
    setOutgoingUploader(async (f) => {
      uploaded++;
      return { filename: f.name, mime_type: f.type, size: f.size, storage_id: "st" };
    });
    const huge = file("huge.bin");
    Object.defineProperty(huge, "size", { value: OUTGOING_MAX_BYTES + 1 });
    await attachToCompose([huge]);
    expect(uploaded).toBe(0);
    expect(mailStore.getState().drafts[draftId].attachments ?? []).toEqual([]);
    expect(mailStore.getState().toasts.some((t) => t.kind === "error")).toBe(true);
  });

  test("removing a ready file drops it from the draft", async () => {
    mailStore.getState().startCompose("new");
    const draftId = mailStore.getState().composeDraftId!;
    setOutgoingUploader(async (f) => ({
      filename: f.name,
      mime_type: f.type,
      size: f.size,
      storage_id: "st_rm",
    }));
    await attachToCompose([file("gone.txt")]);
    removeComposeFile(draftId, "s:st_rm");
    expect(mailStore.getState().drafts[draftId].attachments ?? []).toEqual([]);
  });

  test("send waits for the upload, then includes the file", async () => {
    mailStore.getState().startCompose("new");
    mailStore.getState().updateComposeDraft({ to: [{ email: "ada@example.com" }], subject: "Hi", body_text: "x" });
    let finish: (v: { filename: string; mime_type: string; size: number; storage_id: string }) => void;
    setOutgoingUploader(
      (f) =>
        new Promise((resolve) => {
          finish = resolve;
          void f;
        }),
    );
    const attaching = attachToCompose([file("a.txt")]);
    const sending = sendComposeReady();
    finish!({ filename: "a.txt", mime_type: "text/plain", size: 5, storage_id: "st_send" });
    await attaching;
    await sending;
    const sent = Object.values(mailStore.getState().threads).find((t) => t.subject === "Hi")!;
    expect(sent.has_attachments).toBe(true);
    expect(mailStore.getState().threadMessages[sent.gmail_id]![0].attachments[0].filename).toBe("a.txt");
  });
});
