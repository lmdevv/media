import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { harnessPort } from "./config.ts";

/** Dev harness for the player: `engine.html` drives the engine, `index.html` a full session. */
export default defineConfig({
  root: import.meta.dirname,
  // `scripts/dev-backend.sh` writes VITE_CONVEX_URL for the web app; the harness reuses it.
  envDir: resolve(import.meta.dirname, "../../../apps/web"),
  plugins: [react()],
  server: { host: "127.0.0.1", port: harnessPort, strictPort: true },
});
