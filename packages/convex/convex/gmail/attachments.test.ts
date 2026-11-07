import { describe, expect, test } from "bun:test";
import { attachmentHeaders } from "./attachments";

// The attack this guards against: anyone can mail you an attachment and choose
// its MIME type. The download URL carries the reader's bearer token in its
// query string, so an attachment that renders as HTML on the deployment origin
// can read that token out of location.search and post it anywhere. Attacker
// content must therefore never be served with a type the browser will execute.

describe("attachmentHeaders", () => {
  const executable = [
    "text/html",
    "TEXT/HTML",
    "text/html; charset=utf-8",
    "image/svg+xml",
    "application/xhtml+xml",
    "text/xml",
    "application/javascript",
  ];

  for (const mime of executable) {
    test(`${mime} downloads instead of rendering`, () => {
      const headers = attachmentHeaders(mime, "invoice.html");
      expect(headers["Content-Type"]).toBe("application/octet-stream");
      expect(headers["Content-Disposition"]).toStartWith("attachment;");
    });
  }

  test("raster images still render inline, so cid: mail images work", () => {
    const headers = attachmentHeaders("image/png", "logo.png");
    expect(headers["Content-Type"]).toBe("image/png");
    expect(headers["Content-Disposition"]).toStartWith("inline;");
  });

  test("a parameterised image type is matched on its base type", () => {
    expect(attachmentHeaders("IMAGE/JPEG; foo=bar", "p.jpg")["Content-Type"]).toBe(
      "image/jpeg",
    );
  });

  test("unknown types download", () => {
    const headers = attachmentHeaders("application/zip", "bundle.zip");
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(headers["Content-Disposition"]).toStartWith("attachment;");
  });

  test("every response carries nosniff and a sandbox CSP", () => {
    for (const mime of ["image/png", "text/html", "application/pdf"]) {
      const headers = attachmentHeaders(mime, "f");
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Content-Security-Policy"]).toBe("default-src 'none'; sandbox");
    }
  });

  test("a filename cannot forge extra headers or break the quoting", () => {
    const headers = attachmentHeaders(
      "image/png",
      'evil".png\r\nSet-Cookie: a=b',
    );
    const disposition = headers["Content-Disposition"];
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    expect(disposition).toBe('inline; filename="evil_.png__Set-Cookie: a=b"');
  });
});
