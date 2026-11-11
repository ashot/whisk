// Whisk desktop: the shared shell (@platform/desktop) configured for Whisk.
// The shell loads whisk.email, keeps a full copy of the site so the app works
// offline, updates itself from dl.whisk.email, and answers mailto: links.
const fs = require("fs");
const path = require("path");
const { app, net, screen, shell } = require("electron");
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

// ── The calendar window ────────────────────────────────────────────────────
// The calendar is a window of its own: a detached tab window on /#calendar,
// keyed so asking again brings it forward. The web layer routes every way of
// reaching the calendar here (lib/calendarWindow.ts), and an event to show
// rides along: in the URL for a new window, as an event for an open one.
function openCalendar(api, eventId) {
  const id = typeof eventId === "string" && /^[\w-]+$/.test(eventId) ? eventId : null;
  const opened = api.openTabWindow(`/${id ? `?event=${id}` : ""}#calendar`, { key: "calendar" });
  if (opened && !opened.created && id) api.emit("calendar-open", id);
}

// ── The meeting card ───────────────────────────────────────────────────────
// A meeting about to start shows as a card floating over every app, Space and
// full-screen window, top right of the screen the pointer is on, with its
// sound. It stays until joined, opened or dismissed, so it is hard to miss.
// The web layer decides when a meeting alerts and sends each stage once
// ("soon", then "now" as it starts); "now" comes back even after a dismissed
// "soon", unless the meeting was joined. The card page is the site's
// /meeting-alert/ (packages/web/src/meetingAlert).
const CARD_WIDTH = 380;
const CARD_MARGIN = 6;
const alerts = new Map(); // meeting key → payload, in arrival order
const joined = new Map(); // meeting key → end, so a joined meeting stays quiet
let card = null;
let cardReady = false;
let pendingChime = null;

function cleanAlert(p) {
  if (!p || typeof p.key !== "string" || (p.stage !== "soon" && p.stage !== "now")) return null;
  const num = (n) => (Number.isFinite(n) ? Number(n) : null);
  const str = (v) => (typeof v === "string" && v ? v.slice(0, 300) : null);
  const join = str(p.join);
  const color = str(p.color);
  if (num(p.start) === null || num(p.end) === null) return null;
  return {
    key: p.key.slice(0, 300),
    stage: p.stage,
    eventId: str(p.eventId),
    title: str(p.title) ?? "Upcoming event",
    start: num(p.start),
    end: num(p.end),
    join: join && /^https?:\/\//i.test(join) ? join : null,
    where: str(p.where),
    color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : null,
    sound: p.sound !== false,
  };
}

function placeCard(height) {
  if (!card || card.isDestroyed()) return;
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const h = Math.max(80, Math.min(Math.round(height || 200), workArea.height - 2 * CARD_MARGIN));
  card.setBounds({ x: workArea.x + workArea.width - CARD_WIDTH - CARD_MARGIN, y: workArea.y + CARD_MARGIN, width: CARD_WIDTH, height: h });
}

function cardState(chime = null) {
  return { alerts: [...alerts.values()], chime };
}

function refreshCard(api, chime) {
  if (alerts.size === 0) {
    if (card && !card.isDestroyed()) card.close();
    return;
  }
  if (!card || card.isDestroyed()) {
    cardReady = false;
    pendingChime = chime;
    card = api.openWindow({
      path: "/meeting-alert/",
      width: CARD_WIDTH,
      height: 200,
      minWidth: CARD_WIDTH,
      minHeight: 80,
      resizable: false,
      backgroundColor: "#00000000",
      showInactive: true,
      window: {
        type: "panel",
        frame: false,
        transparent: true,
        hasShadow: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        acceptFirstMouse: true,
      },
    });
    card.setWindowButtonVisibility?.(false);
    card.setAlwaysOnTop(true, "screen-saver");
    card.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    placeCard(200);
    card.on("closed", () => {
      card = null;
      cardReady = false;
    });
    return;
  }
  if (!card.isVisible()) card.showInactive();
  if (cardReady) api.emit("meeting-alerts", cardState(chime));
  else pendingChime = chime ?? pendingChime;
}

function showMeetingAlert(payload, api) {
  const alert = cleanAlert(payload);
  if (!alert || joined.has(alert.key)) return { shown: false };
  const before = alerts.get(alert.key);
  if (before && before.stage === alert.stage) return { shown: true };
  alerts.delete(alert.key); // re-inserted last: the newest stage on the bottom
  alerts.set(alert.key, alert);
  refreshCard(api, alert.sound ? alert.stage : null);
  // Starting now: the Dock icon jumps once as well.
  if (alert.stage === "now") app.dock?.bounce("informational");
  return { shown: true };
}

function meetingAction({ key, action } = {}, api) {
  const alert = alerts.get(key);
  if (!alert) return;
  if (action === "join" && alert.join) {
    joined.set(key, alert.end);
    void shell.openExternal(alert.join);
  } else if (action === "open") {
    openCalendar(api, alert.eventId);
  } else if (action !== "dismiss") return;
  alerts.delete(key);
  refreshCard(api, null);
}

// A card nobody acted on leaves ten minutes into the meeting.
function sweepAlerts(api) {
  const now = Date.now();
  let changed = false;
  for (const [key, a] of alerts) {
    if (now > Math.min(a.end, a.start + 10 * 60_000)) {
      alerts.delete(key);
      changed = true;
    }
  }
  for (const [key, end] of joined) if (now > end) joined.delete(key);
  if (changed) refreshCard(api, null);
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
      // The web layer opens the calendar window for this path.
      { label: "Calendar", path: "/#calendar" },
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
      "calendar-window": (eventId, api) => openCalendar(api, eventId),
      // The calendar window sends mail and other views here.
      "main-window": (navPath, api) => {
        if (typeof navPath === "string" && navPath.startsWith("/") && !navPath.startsWith("//")) api.navigateMain(navPath);
      },
      "meeting-alert": (payload, api) => showMeetingAlert(payload, api),
      "meeting-alert-action": (args, api) => meetingAction(args, api),
      "meeting-alert-state": () => {
        cardReady = true;
        const state = cardState(pendingChime);
        pendingChime = null;
        return state;
      },
      "meeting-alert-size": (height) => placeCard(Number(height)),
    },
    events: ["calendar-open", "meeting-alerts"],
  },
  hooks: {
    // macOS asks for notification permission the first time an app posts one;
    // ask up front, not the first time mail happens to arrive.
    onReady: (api, { firstRun }) => {
      if (firstRun) api.showNotification("Whisk is ready", "New mail lands here. Press ? in Whisk for every key.");
      setInterval(() => sweepAlerts(api), 30_000);
    },
  },
});
