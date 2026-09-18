import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts: that file wires @crxjs/vite-plugin with
// the extension manifest, which must never run under the test runner.
// jsdom is required because mpd-parser calls DOMParser at import/use time.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
