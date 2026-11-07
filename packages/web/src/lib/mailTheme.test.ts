import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { adaptToTheme } from "./mailTheme";

const DARK_PAGE = "#161310";

function docOf(html: string): Document {
  const doc = new Window().document as unknown as Document;
  doc.body.innerHTML = html;
  return doc;
}

const el = (d: Document, id: string) => d.getElementById(id)!;

describe("adaptToTheme dark", () => {
  test("dark text with nothing behind it falls back to the theme ink", () => {
    const d = docOf(
      `<p id="a" style="color:#000;margin:0">hi</p><font id="b" color="#222222">x</font><span id="c" style="color: rgb(34, 34, 34) !important">y</span>`,
    );
    adaptToTheme(d, "dark", DARK_PAGE);
    expect(el(d, "a").getAttribute("style")).toBe("margin:0");
    expect(el(d, "b").hasAttribute("color")).toBe(false);
    expect(el(d, "c").getAttribute("style")).not.toContain("color");
  });

  test("dark text on a painted background keeps its color", () => {
    const d = docOf(
      `<table bgcolor="#ffffff"><tr><td id="a" style="color:#000">in a card</td></tr></table><div style="background:url(x.png)"><span id="b" style="color:#111">on an image</span></div>`,
    );
    adaptToTheme(d, "dark", DARK_PAGE);
    expect(el(d, "a").getAttribute("style")).toBe("color:#000");
    expect(el(d, "b").getAttribute("style")).toBe("color:#111");
  });

  test("readable colors and background-color declarations are untouched", () => {
    const d = docOf(
      `<a id="a" style="color:#c93a0e">link</a><span id="b" style="color:#ffffff">light</span><div id="c" style="background-color:#000000; color:#eee">x</div>`,
    );
    adaptToTheme(d, "dark", DARK_PAGE);
    expect(el(d, "a").getAttribute("style")).toBe("color:#c93a0e");
    expect(el(d, "b").getAttribute("style")).toBe("color:#ffffff");
    expect(el(d, "c").getAttribute("style")).toBe("background-color:#000000; color:#eee");
  });

  test("dark ink on a background-color:transparent wrapper still falls back", () => {
    const d = docOf(`<div style="background-color:transparent"><p id="a" style="color:black">x</p></div>`);
    adaptToTheme(d, "dark", DARK_PAGE);
    expect(el(d, "a").getAttribute("style")).toBe("");
  });
});

describe("adaptToTheme light", () => {
  test("near-white backgrounds drop, brand colors and dark ink stay", () => {
    const d = docOf(
      `<table id="a" bgcolor="#ffffff"><tr><td id="b" style="background-color:#f7f7f7;color:#000">x</td><td id="c" style="background:#0a66c2">y</td></tr></table>`,
    );
    adaptToTheme(d, "light", "#f6f3ec");
    expect(el(d, "a").hasAttribute("bgcolor")).toBe(false);
    expect(el(d, "b").getAttribute("style")).toBe("color:#000");
    expect(el(d, "c").getAttribute("style")).toBe("background:#0a66c2");
  });
});
