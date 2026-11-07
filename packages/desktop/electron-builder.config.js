module.exports = require("@platform/desktop/templates/electron-builder")({
  appId: "email.whisk.desktop",
  productName: "Whisk",
  protocol: "whisk",
  publishUrl: "https://dl.whisk.email/desktop",
  identity: "Ashot Petrosian (WRG9THCK9Q)",
  files: ["main.js", "assets/icon.png"],
  icon: "assets/icon.png",
  category: "public.app-category.productivity",
  extraProtocols: [{ scheme: "mailto", name: "Email address" }],
  // The site as built, the offline copy's seed (see main.js).
  extraResources: [{ from: "web", to: "web" }],
  // Banners clear themselves; mail arrives too often for a notification that
  // waits to be dismissed. Whoever prefers persistent alerts chooses them in
  // System Settings, which the notification panel links to.
  extendInfo: { NSUserNotificationAlertStyle: "banner" },
});
