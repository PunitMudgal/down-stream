import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json" with { type: "json" };

// CRXJS MV3 setup: manifest.json is the source of truth.
// `npm run build` outputs a loadable extension to dist/.
export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
