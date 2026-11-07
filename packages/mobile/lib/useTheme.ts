import { mailStore } from "@mail/shared/src/store/mailStore";
import { dark, light, type Theme } from "./theme";

/** Theme follows the same client_state pref the web app syncs; light is the
 *  hero and the default. */
export function useTheme(): { t: Theme; mode: "light" | "dark" } {
  const mode = (mailStore as any)((s: any) =>
    s.clientState?.theme === "dark" ? "dark" : "light",
  ) as "light" | "dark";
  return { t: mode === "dark" ? dark : light, mode };
}
