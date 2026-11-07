import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { MARK_CLASS, MISSING_CLASS, declaredBox, lostImageCss, watchLostImages } from "./lostImages";

function docOf(html: string): Document {
  const doc = new Window().document as unknown as Document;
  doc.body.innerHTML = html;
  return doc;
}

const el = (d: Document, id: string) => d.getElementById(id) as HTMLImageElement;

/** Nothing loads in a test DOM, so each failure path is staged by hand: an
 *  image that had already failed when the frame loaded, and one the host
 *  refuses afterwards. The component handles both. */
function failNow(img: HTMLImageElement): void {
  Object.defineProperty(img, "complete", { value: true, configurable: true });
  Object.defineProperty(img, "naturalWidth", { value: 0, configurable: true });
}

/** A request still in flight. A browser reports complete false until the image
 *  settles; a test DOM fetches nothing, so it has to be said out loud. */
function stillLoading(img: HTMLImageElement): void {
  Object.defineProperty(img, "complete", { value: false, configurable: true });
}

describe("declaredBox", () => {
  test("reads attributes and inline px", () => {
    const d = docOf(`<img id="a" width="64" height="64"><img id="b" style="width:48px;height:12px">`);
    expect(declaredBox(el(d, "a"))).toEqual({ width: 64, height: 64 });
    expect(declaredBox(el(d, "b"))).toEqual({ width: 48, height: 12 });
  });

  test("a size that is not px is no size at all", () => {
    const d = docOf(`<img id="a" width="100%" height="auto"><img id="b" style="width:50%"><img id="c">`);
    for (const id of ["a", "b", "c"]) expect(declaredBox(el(d, id))).toEqual({ width: Infinity, height: Infinity });
  });
});

describe("an image whose host no longer serves it", () => {
  test("keeps its box, drops its alt text, and takes the mark", () => {
    const d = docOf(
      `<img id="a" src="https://media.licdn.com/gone" alt="Zachary DeWitt’s Profile Picture" width="64" height="64" style="border-radius:9999px">`,
    );
    const img = el(d, "a");
    failNow(img);
    watchLostImages(d);
    expect(img.classList.contains(MISSING_CLASS)).toBe(true);
    expect(img.classList.contains(MARK_CLASS)).toBe(true);
    expect(img.getAttribute("alt")).toBe("");
    expect(img.style.display).not.toBe("none");
    // The shape the mail asked for is untouched, so an avatar stays a circle.
    expect(img.getAttribute("style")).toContain("border-radius");
  });

  test("a sized box trades its dead source for a blank of the same proportions", () => {
    const d = docOf(`<img id="a" src="https://x/gone" srcset="https://x/gone 2x" width="560" height="220">`);
    const img = el(d, "a");
    failNow(img);
    watchLostImages(d);
    expect(img.hasAttribute("srcset")).toBe(false);
    const src = img.getAttribute("src")!;
    expect(src.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(src)).toContain('viewBox="0 0 560 220"');
  });

  test("an unsized box keeps its source, so it cannot grow a guessed shape", () => {
    const d = docOf(`<img id="a" src="https://x/gone" alt="LinkedIn">`);
    const img = el(d, "a");
    failNow(img);
    watchLostImages(d);
    expect(img.getAttribute("src")).toBe("https://x/gone");
    expect(img.classList.contains(MISSING_CLASS)).toBe(true);
  });

  test("is caught when the host refuses it after the frame has loaded", () => {
    const d = docOf(`<img id="a" src="https://media.licdn.com/gone" alt="x" width="64" height="64">`);
    const img = el(d, "a");
    stillLoading(img);
    watchLostImages(d);
    expect(img.classList.contains(MISSING_CLASS)).toBe(false);
    const view = d.defaultView as unknown as { Event: typeof Event };
    img.dispatchEvent(new view.Event("error"));
    expect(img.classList.contains(MISSING_CLASS)).toBe(true);
  });

  test("small enough, it is a quiet disc with no mark in it", () => {
    const d = docOf(`<img id="a" src="x" width="24" height="24"><img id="b" src="x" width="36" height="36">`);
    for (const id of ["a", "b"]) failNow(el(d, id));
    watchLostImages(d);
    expect(el(d, "a").classList.contains(MISSING_CLASS)).toBe(true);
    expect(el(d, "a").classList.contains(MARK_CLASS)).toBe(false);
    expect(el(d, "b").classList.contains(MARK_CLASS)).toBe(true);
  });

  test("an inline part that never resolved is lost immediately", () => {
    // resolveCidImages strips the src of a cid: part it cannot point anywhere,
    // so nothing will load and no error will ever fire.
    const d = docOf(`<img id="a" alt="an attached photo">`);
    watchLostImages(d);
    expect(el(d, "a").classList.contains(MISSING_CLASS)).toBe(true);
    expect(el(d, "a").getAttribute("alt")).toBe("");
  });
});

describe("images that were never meant to be seen", () => {
  test("a tracking pixel and a spacer stay invisible", () => {
    const d = docOf(`<img id="a" src="x" width="1" height="1" alt=""><img id="b" src="x" width="100%" height="1">`);
    for (const id of ["a", "b"]) failNow(el(d, id));
    watchLostImages(d);
    for (const id of ["a", "b"]) {
      expect(el(d, id).style.display).toBe("none");
      expect(el(d, id).classList.contains(MISSING_CLASS)).toBe(false);
    }
  });
});

describe("lostImageCss", () => {
  test("paints from the theme it is given, and caps the mark", () => {
    const css = lostImageCss("#cfc6b2", "#6b6355");
    expect(css).toContain("#cfc6b224");
    expect(css).toContain(encodeURIComponent("#6b6355"));
    expect(css).toContain("min(42%, 26px)");
  });

  test("a token that is not 6-digit hex is used as it came", () => {
    expect(lostImageCss("rgb(1 2 3)", "#6b6355")).toContain("background-color: rgb(1 2 3)");
  });
});
