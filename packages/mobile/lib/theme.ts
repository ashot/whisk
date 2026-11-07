// The reading room, on glass. The palette is the family's (@platform/design),
// the same values Whisk's web sheet and codecast's simple lane read: email as
// typeset correspondence, paper-warm light, ink-warm dark, one vermilion
// accent spent only where attention goes.
import { PALETTE, type Palette } from "@platform/design";

/** The palette colours the native views paint with (the shadows are CSS). */
export type Theme = Pick<
  Palette,
  | "bg"
  | "bgRaised"
  | "bgSunken"
  | "bgHover"
  | "ink"
  | "inkMuted"
  | "inkFaint"
  | "rule"
  | "ruleStrong"
  | "accent"
  | "accentInk"
  | "accentSoft"
  | "star"
  | "ok"
  | "danger"
>;

export const light: Theme = PALETTE.light;
export const dark: Theme = PALETTE.dark;

export const fonts = {
  ui: "InstrumentSans_400Regular",
  uiMedium: "InstrumentSans_500Medium",
  uiSemiBold: "InstrumentSans_600SemiBold",
  read: "Newsreader_400Regular",
  readItalic: "Newsreader_500Medium_Italic",
  readSemiBold: "Newsreader_600SemiBold",
  mono: "FragmentMono_400Regular",
};

/** Avatar disc color for a sender hue (web paints oklch(0.52 0.11 h); HSL is
 *  the closest RN can express — same warm arc, similar weight). */
export function avatarColor(hue: number, theme: "light" | "dark"): string {
  return theme === "dark" ? `hsl(${hue}, 38%, 62%)` : `hsl(${hue}, 46%, 42%)`;
}
