import { describe, expect, test } from "bun:test";
import { previewKind } from "./attachments";

describe("previewKind", () => {
  test("raster images, pdfs and text preview; the rest does not", () => {
    expect(previewKind({ mime_type: "image/png", filename: "a.png" })).toBe("image");
    expect(previewKind({ mime_type: "IMAGE/JPEG; name=x", filename: "a.jpg" })).toBe("image");
    expect(previewKind({ mime_type: "image/svg+xml", filename: "a.svg" })).toBe("none");
    expect(previewKind({ mime_type: "application/pdf", filename: "a.pdf" })).toBe("pdf");
    expect(previewKind({ mime_type: "application/octet-stream", filename: "deck.pdf" })).toBe("pdf");
    expect(previewKind({ mime_type: "text/csv", filename: "a.csv" })).toBe("text");
    expect(previewKind({ mime_type: "application/octet-stream", filename: "notes.md" })).toBe("text");
    expect(previewKind({ mime_type: "application/zip", filename: "a.zip" })).toBe("none");
  });
});
