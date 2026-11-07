// The theme lives in three places that must agree: the DOM attribute the CSS
// reads, localStorage for the pre-render boot script in index.html, and the
// synced client prefs so the choice follows the person to other devices.
import { useSyncExternalStore } from "react";
import { mailStore } from "../store/mailStore";

export type Theme = "light" | "dark";

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function onThemeChange(cb: () => void): () => void {
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** The theme on screen, re-rendering when it flips. Watches the DOM attribute
 *  itself: the synced pref can already hold the new value and never change. */
export function useTheme(): Theme {
  return useSyncExternalStore(onThemeChange, currentTheme);
}

export function setTheme(next: Theme): void {
  document.documentElement.dataset.theme = next === "dark" ? "dark" : "";
  document.documentElement.style.colorScheme = next;
  // The browser's own chrome (Safari's bars, the Android status bar) wears
  // the page colour.
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--m-bg").trim());
  try {
    localStorage.setItem("mail:theme", next);
  } catch {}
  mailStore.getState().setClientPref("theme", next);
}

/** Flip the theme. Given the control that asked, the new theme spreads out
 *  from it as a circle (see `html.theme-shift` in app.css); without one, or
 *  where motion is unwelcome or unsupported, it switches in place. */
export function toggleTheme(from?: Element): void {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  const root = document.documentElement;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  if (!from || !doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setTheme(next);
    return;
  }
  const r = from.getBoundingClientRect();
  root.style.setProperty("--theme-x", `${r.left + r.width / 2}px`);
  root.style.setProperty("--theme-y", `${r.top + r.height / 2}px`);
  root.classList.add("theme-shift");
  doc.startViewTransition(() => setTheme(next)).finished.finally(() => root.classList.remove("theme-shift"));
}
