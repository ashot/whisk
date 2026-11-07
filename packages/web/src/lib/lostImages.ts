// Mail outlives the servers that host its pictures. A LinkedIn digest from
// 2024 still has every <img>, but the signed URLs behind them now answer 400,
// and a broken image renders as its alt text clipped into whatever shape the
// mail styled the picture with, like initials spilling out of a 24px circle.
//
// The image keeps its own box, so an avatar stays the circle the mail asked
// for and nothing reflows; what changes is what fills the box.

/** Marks an image whose source will never arrive. */
export const MISSING_CLASS = "mail-img-lost";
/** Adds the drawn mark, for boxes with room to carry it. */
export const MARK_CLASS = "mail-img-mark";
/** Below this, the mark is cramped and the bare tint reads better: a small
 *  lost avatar should look like a quiet disc, not a tiny diagram. */
export const MARK_MIN_PX = 36;
/** At or under this, an image is a tracking pixel or a layout spacer. It was
 *  invisible when it loaded, so it stays invisible when it fails. */
export const PIXEL_MAX_PX = 4;

/** A theme token at low opacity. The tokens are 6-digit hex, so the alpha is a
 *  suffix; anything else is left alone rather than guessed at. */
function soften(color: string, alpha: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : color;
}

/** The mark left where a picture used to be: a hairline horizon under a low
 *  sun, drawn in the mail's own muted ink. It reads as a faded photograph
 *  rather than a browser's broken-image icon. */
function fadedPhotoMark(color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" ` +
    `stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" opacity="0.5">` +
    `<path d="M2.5 17.5 L8 11.5 L11.5 15 L15.5 10.5 L21.5 17.5"/>` +
    `<circle cx="8" cy="6.75" r="1.6"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** The frame rules for a lost image, in the mail frame's own theme colors.
 *  The mark is capped as well as proportional, so it stays a small quiet
 *  detail whether the box is a 32px disc or a newsletter hero. */
export function lostImageCss(rule: string, muted: string): string {
  return `
  img.${MISSING_CLASS} {
    min-width: 22px; min-height: 22px;
    background-color: ${soften(rule, "24")};
  }
  img.${MARK_CLASS} {
    background-image: ${fadedPhotoMark(muted)};
    background-repeat: no-repeat;
    background-position: center;
    background-size: min(42%, 26px) min(42%, 26px);
  }`;
}

/** The box the mail asked for, in px, with Infinity for a side it did not
 *  give in px. A broken image reports no natural size, so its attributes and
 *  inline style are the only record of how big it was meant to be. */
export function declaredBox(img: HTMLImageElement): { width: number; height: number } {
  const px = (prop: "width" | "height"): number => {
    const raw = img.getAttribute(prop) ?? img.style[prop];
    const n = Number.parseFloat(raw ?? "");
    return raw && /^[\d.]+(px)?$/.test(raw.trim()) && Number.isFinite(n) ? n : Infinity;
  };
  return { width: px("width"), height: px("height") };
}

/** A transparent picture with the given proportions. Standing in for a dead
 *  source, it loads at once, so the browser has no broken image to draw its
 *  own icon over, and the box keeps the shape the mail gave it. */
function blankOf(width: number, height: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"/>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Give up on one image: hide it if it was never meant to be seen, otherwise
 *  leave the placeholder in its place. The alt text is emptied: it is the
 *  clipped text that made the failure ugly. A box the mail sized gets a blank
 *  source of the same proportions, since Chrome draws its broken-image icon in
 *  any sized box; an unsized one stays broken, which the empty alt keeps clean. */
export function markLost(img: HTMLImageElement): void {
  const { width, height } = declaredBox(img);
  const size = Math.min(width, height);
  if (size <= PIXEL_MAX_PX) {
    img.style.display = "none";
    return;
  }
  img.setAttribute("alt", "");
  img.classList.add(MISSING_CLASS);
  if (size >= MARK_MIN_PX) img.classList.add(MARK_CLASS);
  if (Number.isFinite(size)) {
    img.removeAttribute("srcset");
    img.setAttribute("src", blankOf(width, height));
  }
}

/** Watch every image in a rendered mail body. Images that already failed are
 *  caught on the spot; the rest are caught if and when their host refuses
 *  them. Callers re-measure afterwards, since the box can change size. */
export function watchLostImages(doc: Document): void {
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const lost = () => markLost(img);
    // No src at all is an inline part that never resolved: nothing will ever
    // load and no error will ever fire, so it is lost right now.
    if (!img.getAttribute("src")) lost();
    else if (img.complete && img.naturalWidth === 0) lost();
    else img.addEventListener("error", lost);
  }
}
