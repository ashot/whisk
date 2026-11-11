import { mailStore } from "./store/mailStore";
import { consumeAuthFragment } from "./sync/ConvexSync";
import { desktopBridge } from "./lib/desktopBridge";
import { attachCalendarWindow } from "./lib/calendarWindow";

// What the web app does differently inside the desktop shell: deep links
// (the sign-in result, mailto:, a notification click), the menu's navigation,
// and the offline copy moving on. New mail banners and the dock badge are
// not desktop-only and live in lib/notifier.

/** mailto:a@x.com,b@y.com?subject=…&body=…&cc=…&bcc=… */
function composeFromMailto(u: URL): void {
  const list = (s: string | null) =>
    (s ?? "")
      .split(",")
      .map((a) => decodeURIComponent(a).trim())
      .filter(Boolean)
      .map((email) => ({ email }));
  const q = u.searchParams;
  const s = mailStore.getState();
  s.startCompose("new");
  s.updateComposeDraft({
    to: [...list(u.pathname), ...list(q.get("to"))],
    cc: list(q.get("cc")),
    bcc: list(q.get("bcc")),
    subject: q.get("subject") ?? "",
    body_text: q.get("body") ?? "",
  });
}

function handleUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return;
  }
  if (u.protocol === "mailto:") {
    composeFromMailto(u);
    return;
  }
  if (u.protocol !== "whisk:") return;
  const hash = u.hash.slice(1);
  // The OAuth callback: whisk://app#token=… (or #attached=1, #error=…).
  if (/^(token|error|attached)=/.test(hash)) consumeAuthFragment(hash);
  // A notification click with no window open: whisk://open/#t/<id>.
  else if (hash) window.location.hash = `#${hash}`;
}

function navigateTo(detail: unknown): void {
  const p = typeof detail === "string" ? detail : (detail as { path?: string } | null)?.path;
  if (!p) return;
  if (p === "/#settings" || p.endsWith("#settings")) {
    mailStore.getState().setSettings(true);
    return;
  }
  const i = p.indexOf("#");
  window.location.hash = i >= 0 ? p.slice(i) : "#inbox";
}

export function attachDesktop(): void {
  const bridge = desktopBridge();
  if (!bridge) return;
  // The shell adds this class on load too; adding it here avoids a flash.
  document.documentElement.classList.add("desktop");

  bridge.onDeepLink(handleUrl);
  // The calendar is a window of its own here.
  attachCalendarWindow();
  window.addEventListener("whisk-navigate", (e) => navigateTo((e as CustomEvent).detail));
  window.__WHISK_NEW_SESSION = () => {
    const s = mailStore.getState();
    if (!s.composeDraftId) s.startCompose("new");
  };
  // The shell reloads on a new release (web.reloadOnUpdate). Keep this as a
  // fallback for a build that only sends the event.
  bridge.onWebUpdate(() => location.reload());
}

declare global {
  interface Window {
    __WHISK_NEW_SESSION?: () => void;
  }
}
