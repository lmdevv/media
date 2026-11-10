import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const DEFAULT_PORT = 3001;

const SECURITY_HEADERS = { "Referrer-Policy": "no-referrer" };

const parsePort = (value: string | undefined): number => {
  if (value === undefined || value === "") return DEFAULT_PORT;

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`WEB_PORT must be a TCP port number, got "${value}".`);
  }

  return port;
};

/**
 * The movies client lives at `/movies/` on the same origin as the account client at `/`, so both
 * share the browser's one session (ADR 0020). In development this server serves `/movies/` and
 * passes every other path, the account client's pages and its module graph included, to the
 * account client's dev server at `ACCOUNT_DEV_URL`.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "");
  const account = env["ACCOUNT_DEV_URL"] ?? "";
  const proxy: Record<string, { target: string; ws: boolean }> = {};

  if (account !== "") proxy["^/(?!movies(?:/|$))"] = { target: account, ws: true };

  return {
    base: "/movies/",
    server: { port: parsePort(env["WEB_PORT"]), headers: SECURITY_HEADERS, proxy },
    preview: { headers: SECURITY_HEADERS },
    resolve: { tsconfigPaths: true },
    plugins: [
      tailwindcss(),
      tanstackRouter({ target: "react", autoCodeSplitting: true, routeTreeFileHeader: [] }),
      react(),
    ],
  };
});
