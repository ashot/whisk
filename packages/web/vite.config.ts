import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { releaseManifest } from "@platform/desktop/vite";
import { designTokens } from "@platform/design/vite";

export default defineConfig({
  // release.json: the manifest the desktop shell's offline copy refreshes from.
  // designTokens: the family sheet (@platform/design) at the top of every
  // page's head, so the first paint and index.html's boot script read it.
  plugins: [react(), releaseManifest(), designTokens()],
  // @platform/auth is a file: dep with its own peer copies of react and
  // @convex-dev/auth in bun's isolated store. Auth state lives in a React
  // context, so the bundle must hold exactly one instance of each.
  resolve: { dedupe: ["react", "react-dom", "@convex-dev/auth", "@auth/core", "convex"] },
  server: { port: 3300, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        privacy: resolve(__dirname, "privacy/index.html"),
        terms: resolve(__dirname, "terms/index.html"),
        // The desktop app's floating meeting card (packages/desktop/main.js).
        meetingAlert: resolve(__dirname, "meeting-alert/index.html"),
      },
    },
  },
});
