// Whisk desktop: the shared shell (@platform/desktop) configured for Whisk.
// The shell loads whisk.email, keeps a full copy of the site so the app works
// offline, updates itself from dl.whisk.email, and answers mailto: links.
const fs = require("fs");
const path = require("path");
const { app, net, shell } = require("electron");
const { createDesktopApp } = require("@platform/desktop");

// The site as built at package time (electron-builder extraResources), the
// offline copy's seed until the first download.
const seedDir = app.isPackaged ? path.join(process.resourcesPath, "web") : path.join(__dirname, "web");

function isAttachment(url) {
  try {
    const u = new URL(url);
    return u.hostname.endsWith(".convex.site") && u.pathname === "/gmail/attachment";
  } catch {
    return false;
  }
}

// Every file in an open conversation lands here as the conversation opens,
// so the web layer can show it at once and hand it to Finder. One flat
// folder in Downloads, where people look for files; macOS asks once for
// access to it the first time a conversation with a file opens.
// (The shell repoints Electron's own "downloads" path into the app data
// dir, so the real folder comes from the home directory.)
const attachmentsRoot = () => path.join(app.getPath("home"), "Downloads", "Whisk");

// Only paths inside the folder are ever read, revealed or opened: the
// renderer names files, the shell decides whether the name is allowed.
function insideRoot(p) {
  const root = attachmentsRoot();
  const resolved = path.resolve(String(p));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("not an attachment path");
  return resolved;
}

// Path separators and traversal are stripped in the web layer too, but the
// shell is the one that writes, so it checks for itself.
function segment(s) {
  const clean = String(s ?? "").replace(/[/\\\x00-\x1f]/g, " ").trim().replace(/^\.+/, "");
  if (!clean) throw new Error("empty path segment");
  return clean;
}

function numbered(name, n) {
  if (n === 1) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

/** Where a file of this name and size lives in the folder: the copy already
 *  there when one has the expected size, else the first free name, so two
 *  different "invoice.pdf"s become "invoice.pdf" and "invoice (2).pdf". */
async function placeFor(root, name, size) {
  for (let n = 1; ; n++) {
    const file = path.join(root, numbered(name, n));
    let st;
    try {
      st = await fs.promises.stat(file);
    } catch {
      return { file, have: false };
    }
    if (st.isFile() && (!size || st.size === size)) return { file, have: true, size: st.size };
  }
}

/** Download one attachment to `<root>/<name>`; a copy already there with the
 *  expected size is reused, so opening a conversation twice costs one
 *  download. */
async function fetchAttachment({ url, name, size }) {
  if (!isAttachment(url)) throw new Error("not an attachment url");
  const root = attachmentsRoot();
  await fs.promises.mkdir(root, { recursive: true });
  const place = await placeFor(root, segment(name), size);
  if (place.have) return { path: place.file, size: place.size };
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  // Write beside, then rename: a half-written file must never look ready.
  const tmp = `${place.file}.part`;
  await fs.promises.writeFile(tmp, bytes);
  await fs.promises.rename(tmp, place.file);
  return { path: place.file, size: bytes.length };
}

createDesktopApp({
  productName: "Whisk",
  appId: "email.whisk.desktop",
  protocol: "whisk", // whisk://app#token=… carries the sign-in result back from the browser
  urls: { prod: "https://whisk.email" },
  events: { htmlClass: "desktop" },
  assets: { icon: path.join(__dirname, "assets", "icon.png") },
  window: {
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#f6f3ec",
    trafficLightPosition: { x: 14, y: 16 },
  },
  menu: {
    navItems: [
      { label: "Inbox", path: "/#inbox" },
      { label: "Starred", path: "/#starred" },
      { label: "Sweep", path: "/#sweep" },
      { label: "Sent", path: "/#sent" },
      { label: "Drafts", path: "/#drafts" },
    ],
    newSessionLabel: "New Message",
    // Cmd-, in the app menu. The web layer opens the overlay on this path
    // instead of navigating (see desktop.ts).
    settingsPath: "/#settings",
    helpLinks: [
      { label: "Privacy Policy", url: "https://whisk.email/privacy/" },
      { label: "Terms of Service", url: "https://whisk.email/terms/" },
    ],
  },
  // mailto: makes Whisk eligible as the system's default mail app; the first
  // launch asks, the menu asks again.
  extraProtocols: [{ scheme: "mailto", name: "Email address", claimOnFirstRun: true, menuLabel: "Make Whisk the Default Mail App" }],
  // Attachments stream from the backend; they download in-app instead of
  // bouncing through the browser.
  downloadUrls: isAttachment,
  // "assets" verifies every script, stylesheet and font against the release
  // manifest, but not the HTML: Cloudflare rewrites mailto: links in the
  // documents it serves, so a strict check rejects every release and the app
  // quietly stops updating.
  // Live HTML from whisk.email so a web deploy is on screen without a
  // desktop rebuild. The copy is the offline fallback, refreshed on launch,
  // on focus, and every two minutes; a new release reloads the window.
  web: {
    cache: true,
    verify: "assets",
    seedDir: fs.existsSync(seedDir) ? seedDir : null,
    preferNetwork: true,
    reloadOnUpdate: true,
    checkIntervalMs: 2 * 60 * 1000,
  },
  update: { baseUrl: "https://dl.whisk.email/desktop", teamId: "WRG9THCK9Q" },
  about: { copyright: "Almost Candid", website: "https://whisk.email" },
  ipc: {
    handlers: {
      "attachment-fetch": (args) => fetchAttachment(args ?? {}),
      "attachment-read": (p) => fs.promises.readFile(insideRoot(p)),
      "attachment-reveal": (p) => shell.showItemInFolder(insideRoot(p)),
      "attachment-open": (p) => shell.openPath(insideRoot(p)),
      "attachment-quicklook": (p, name, api) => api.getMainWindow()?.previewFile(insideRoot(p), String(name ?? "")),
    },
  },
  hooks: {
    // macOS asks for notification permission the first time an app posts one;
    // ask up front, not the first time mail happens to arrive.
    onReady: (api, { firstRun }) => {
      if (firstRun) api.showNotification("Whisk is ready", "New mail lands here. Press ? in Whisk for every key.");
    },
  },
});
