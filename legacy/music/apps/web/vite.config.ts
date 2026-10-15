import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

/** The body font's Latin subset, as `@fontsource-variable/inter` names it. */
const BODY_FONT = /^assets\/inter-latin-wght-normal-[\w-]+\.woff2$/;

/**
 * Preloads the body font from `index.html`. The stylesheet only asks for it once text is laid out,
 * after the scripts ran, so text first painted in a fallback font and moved when Inter arrived.
 */
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
            href: `/${font.fileName}`,
            crossorigin: true,
          },
          injectTo: "head",
        },
      ];
    },
  },
});

export default defineConfig({
  server: {
    port: 3001,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    preloadBodyFont(),
  ],
});
