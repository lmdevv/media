import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/geist-mono/index.css";

import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { LazyPageNotFound, LazyRouteError } from "./components/lazy-route-error";
import { resolveConvexUrl } from "./config";
import { convexLogger } from "./lib/convex-logger";
import { parseSearch, stringifySearch } from "./lib/search-params";
import { whenSettled } from "./lib/when-settled";
import { routeTree } from "./routeTree.gen";

const convex = new ConvexReactClient(resolveConvexUrl(), { logger: convexLogger(console) });

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  // Every route gets its own boundaries, so a failing or missing screen under `/_app` renders inside
  // the shell and leaves the player (and its audio) mounted.
  defaultErrorComponent: LazyRouteError,
  defaultNotFoundComponent: LazyPageNotFound,
  scrollRestoration: true,
  // Search values stay plain strings; each route parses its own with a schema.
  parseSearch,
  stringifySearch,
  Wrap: function Providers({ children }: { readonly children: ReactNode }) {
    return <ConvexAuthProvider client={convex}>{children}</ConvexAuthProvider>;
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("app");

if (rootElement === null) throw new Error("The #app element is missing from index.html");

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

// The error screens are a chunk of their own, off the first screen's path. Load it once the page
// settles, so a screen that fails later (or offline) still has its message ready. If this fails,
// the error screen tries again when needed and falls back to a plain message.
whenSettled(() => {
  import("./components/route-error").catch(() => undefined);
});
