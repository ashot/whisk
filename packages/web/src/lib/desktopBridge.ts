import type { DesktopBridge } from "@platform/desktop";

// The desktop shell (packages/desktop, on @platform/desktop) exposes its
// bridge on this global from its preload. In a browser it is absent.
declare global {
  interface Window {
    __WHISK_ELECTRON__?: DesktopBridge;
  }
}

export function desktopBridge(): DesktopBridge | null {
  return window.__WHISK_ELECTRON__ ?? null;
}

// The origin the backend redirects the sign-in result to (whisk://app#token=…),
// on its allowlist beside the web origins. The page itself is served from
// https://whisk.email; the deep link is how the result reaches the app after
// the consent flow ran in the system browser.
export const DESKTOP_AUTH_ORIGIN = "whisk://app";

export function authOrigin(): string {
  return desktopBridge() ? DESKTOP_AUTH_ORIGIN : window.location.origin;
}
