import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { harnessPort } from "./config.ts";

export default defineConfig({
  root: import.meta.dirname,
  envDir: resolve(import.meta.dirname, "../../../apps/web"),
  plugins: [react()],
  server: { host: "127.0.0.1", port: harnessPort, strictPort: true },
});
