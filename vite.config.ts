import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json" with { type: "json" };

// CRXJS MV3 setup: manifest.json is the source of truth.
// `npm run build` outputs a loadable extension to dist/.
// offscreen.html is an extra entry (created at runtime via
// chrome.offscreen.createDocument) — CRXJS merges user inputs.
export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        offscreen: "src/offscreen.html",
      },
    },
  },
});
