// HTML mail carries inline colors chosen for a white page. These passes fit
// them to the page the mail actually sits on, before it reaches the frame.
import type { Theme } from "./theme";

// Near-white: every channel high and the color effectively opaque. Covers
// #fff/#f7f7f7-style backgrounds without touching brand colors.
const NEAR_WHITE_MIN = 0xf0;

function parseColor(value: string): [number, number, number, number] | null {
  const text = value.replace(/!important/i, "").trim().toLowerCase();
  if (text === "white") return [255, 255, 255, 1];
  if (text === "black") return [0, 0, 0, 1];
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const h = hex[1];
    const expand = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return [
      parseInt(expand.slice(0, 2), 16),
      parseInt(expand.slice(2, 4), 16),
      parseInt(expand.slice(4, 6), 16),
      1,
    ];
  }
  const rgb = text.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  }
  return null;
}

function isNearWhite(value: string): boolean {
  const c = parseColor(value);
  return !!c && c[3] > 0.5 && c[0] >= NEAR_WHITE_MIN && c[1] >= NEAR_WHITE_MIN && c[2] >= NEAR_WHITE_MIN;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance([r, g, b]: [number, number, number, number]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Below this contrast against the page, mail text is effectively invisible. */
const MIN_CONTRAST = 3;

const BACKGROUND_DECL = /background(?:-color|-image)?\s*:\s*([^;]+);?/gi;
const COLOR_DECL = /(^|;)\s*color\s*:\s*([^;]+);?/gi;

/** Does this element paint something behind its text? Anything we cannot
 *  read (an image, a gradient) counts, so the mail's own ink is kept there. */
function paintsBackground(el: Element): boolean {
  const values = [el.getAttribute("bgcolor") ?? ""];
  for (const m of (el.getAttribute("style") ?? "").matchAll(BACKGROUND_DECL)) values.push(m[1]);
  return values.some((value) => {
    const v = value.replace(/!important/i, "").trim().toLowerCase();
    if (!v || v === "transparent" || v === "none" || v === "inherit" || v === "initial") return false;
    const c = parseColor(v);
    return !c || c[3] > 0.5;
  });
}

/** Fit the mail's inline colors to the page it sits on. In light theme a
 *  white canvas on the warm page reads as a pasted-on card, so near-white
 *  backgrounds drop: plain mail sits on the page, real designs keep their
 *  colors. In dark theme whites stay (the mail's ink assumes them), but dark
 *  text with nothing painted behind it would vanish into the page, so it
 *  falls back to the theme's ink. `pageBg` is the color the mail sits on. */
export function adaptToTheme(root: Document, theme: Theme, pageBg: string): void {
  if (theme === "light") {
    for (const el of Array.from(root.body.querySelectorAll("*"))) {
      const bgcolor = el.getAttribute("bgcolor");
      if (bgcolor && isNearWhite(bgcolor)) el.removeAttribute("bgcolor");
      const style = el.getAttribute("style");
      if (!style) continue;
      const cleaned = style.replace(BACKGROUND_DECL, (match, value) => (isNearWhite(value) ? "" : match));
      if (cleaned !== style) el.setAttribute("style", cleaned);
    }
    return;
  }
  const page = parseColor(pageBg) ?? [0, 0, 0, 1];
  const tooDark = (value: string) => {
    const c = parseColor(value);
    return !!c && (luminance(c) + 0.05) / (luminance(page) + 0.05) < MIN_CONTRAST;
  };
  const walk = (el: Element, painted: boolean) => {
    painted ||= paintsBackground(el);
    if (!painted) {
      const color = el.getAttribute("color");
      if (color && tooDark(color)) el.removeAttribute("color");
      const style = el.getAttribute("style");
      if (style) {
        const cleaned = style.replace(COLOR_DECL, (match, lead, value) => (tooDark(value) ? lead : match));
        if (cleaned !== style) el.setAttribute("style", cleaned);
      }
    }
    for (const child of Array.from(el.children)) walk(child, painted);
  };
  walk(root.body, false);
}
