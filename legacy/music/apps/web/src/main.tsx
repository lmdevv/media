import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/geist-mono/index.css";

import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { PageNotFound, RouteError } from "./components/route-error";
import { resolveConvexUrl } from "./config";
import { convexLogger } from "./lib/convex-logger";
import { parseSearch, stringifySearch } from "./lib/search-params";
import { routeTree } from "./routeTree.gen";

const convex = new ConvexReactClient(resolveConvexUrl(), { logger: convexLogger(console) });

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  // Every route gets its own boundaries, so a failing or missing screen under `/_app` renders inside
  // the shell and leaves the player (and its audio) mounted.
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: PageNotFound,
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
