import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";

const DEFAULT_PORT = 3002;

const BASE = "/music/";

const SECURITY_HEADERS = { "Referrer-Policy": "no-referrer" };

const BODY_FONT = /^assets\/inter-latin-wght-normal-[\w-]+\.woff2$/u;

const parsePort = (value: string | undefined): number => {
  if (value === undefined || value === "") return DEFAULT_PORT;

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`MUSIC_PORT must be a TCP port number, got "${value}".`);
  }

  return port;
};

/** Preloads the body font, as old music's web app did, so text paints in it the first time. */
const preloadBodyFont = (): Plugin => ({
  name: "music:preload-body-font",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler: (_html, { bundle }) => {
      const font = Object.values(bundle ?? {}).find((output) => BODY_FONT.test(output.fileName));

      if (font === undefined) {
        throw new Error("The Inter Latin font file is missing from the build; update BODY_FONT");
      }

      return [
        {
          tag: "link",
          attrs: {
            rel: "preload",
            as: "font",
            type: "font/woff2",
            href: `${BASE}${font.fileName}`,
            crossorigin: true,
          },
          injectTo: "head",
        },
      ];
    },
  },
});

/**
 * The music client lives at `/music/` on the same origin as the account client at `/`, so both
 * share the browser's one session (ADR 0020). In development this server serves `/music/` and
 * passes every other path, the account client's pages and its module graph included, to the
 * account client's dev server at `ACCOUNT_DEV_URL`.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "");
  const account = env["ACCOUNT_DEV_URL"] ?? "";
  const proxy: Record<string, { target: string; ws: boolean }> = {};

  if (account !== "") proxy["^/(?!music(?:/|$))"] = { target: account, ws: true };

  return {
    base: BASE,
    server: { port: parsePort(env["MUSIC_PORT"]), headers: SECURITY_HEADERS, proxy },
    preview: { headers: SECURITY_HEADERS },
    resolve: { tsconfigPaths: true },
    plugins: [
      tailwindcss(),
      tanstackRouter({ target: "react", autoCodeSplitting: true, routeTreeFileHeader: [] }),
      react(),
      preloadBodyFont(),
    ],
  };
});
