import React from "react";
import { createRoot } from "react-dom/client";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import "./design/base";
import "./design/app.css";
import { App } from "./App";
import { keyEngine } from "./keys/engine";
import { registerBindings } from "./keys/bindings";
import { authProviderClient, consumeAuthFragment } from "./sync/ConvexSync";
import { durableAuth, localAuth } from "./sync/localAuth";
import { attachDesktop } from "./desktop";
import { startNotifier } from "./lib/notifier";
import { mailStore } from "./store/mailStore";

registerBindings();
keyEngine.attach(window);
// Dev only: the store on a global, so a devtools session (Chrome or the
// desktop shell's remote debugger) can inspect and drive the app.
if (import.meta.env.DEV) (window as any).__whisk = { mailStore };
// Inside the desktop shell: mailto:, deep links and the sign-in return.
attachDesktop();
// New mail banners and the dock badge, under the person's own rules.
startNotifier();
// A same-tab Google sign-in returns here with the token in the fragment.
consumeAuthFragment();

// The static landing served no-JS visitors and crawlers; the app owns the
// page from here.
document.getElementById("static-landing")?.remove();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Convex Auth (Google sign-in) over the app's own ConvexClient. The
        legacy token path runs beside it until cutover. */}
    <ConvexAuthProvider
      client={authProviderClient()}
      storage={durableAuth.storage}
      storageNamespace={localAuth.namespace}
    >
      <App />
    </ConvexAuthProvider>
  </React.StrictMode>,
);
