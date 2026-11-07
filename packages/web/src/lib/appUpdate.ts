import { useEffect, useState } from "react";
import { desktopBridge } from "./desktopBridge";

// A newer Whisk is ready, and the one click that switches to it.
//
// In the desktop app the shell downloads, verifies and stages a new release
// in the background (@platform/desktop's updater) and reports it over
// `update-status`; the click restarts into it. Web deploys need nothing
// there: the shell reloads the window itself.
//
// In a browser tab the page is whatever was deployed when it loaded. Every
// deploy publishes release.json listing its files; once this page's own
// entry script is no longer listed, a newer build is live and a reload
// picks it up. Offline, the check simply fails and nothing shows.

export type AppUpdate = { text: string; action: string; run: () => void };

const CHECK_MS = 10 * 60 * 1000;

function entryScript(): string | null {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src^="/assets/"]')?.getAttribute("src");
  return src ? src.slice(1) : null;
}

async function webIsStale(entry: string): Promise<boolean> {
  try {
    const res = await fetch("/release.json", { cache: "no-store" });
    if (!res.ok) return false;
    const manifest = (await res.json()) as { files?: Record<string, string> };
    return !!manifest.files && !(entry in manifest.files);
  } catch {
    return false;
  }
}

export function useAppUpdate(): AppUpdate | null {
  const [update, setUpdate] = useState<AppUpdate | null>(null);

  useEffect(() => {
    const bridge = desktopBridge();
    if (bridge) {
      bridge.onUpdateStatus((u) => {
        if (u.status !== "ready") return;
        setUpdate({
          text: u.version ? `Whisk ${u.version} is ready` : "A new Whisk is ready",
          action: "Restart",
          run: () => void bridge.restartForUpdate(),
        });
      });
      return;
    }
    const entry = entryScript();
    if (!entry) return; // the dev server serves /src, not a release
    let done = false;
    const check = async () => {
      if (done || document.hidden || !(await webIsStale(entry))) return;
      done = true;
      setUpdate({ text: "A new version of Whisk is out", action: "Reload", run: () => location.reload() });
    };
    const timer = setInterval(check, CHECK_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  return update;
}
