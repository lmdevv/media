import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/geist-mono/index.css";

import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { convexLogger } from "@music/sdk/convex-logger";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { LazyPageNotFound, LazyRouteError } from "./components/lazy-route-error";
import { resolveConvexUrl } from "./config";
import { parseSearch, stringifySearch } from "./lib/search-params";
import { whenSettled } from "./lib/when-settled";
import { routeTree } from "./routeTree.gen";

const convex = new ConvexReactClient(resolveConvexUrl(), { logger: convexLogger(console) });

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultErrorComponent: LazyRouteError,
  defaultNotFoundComponent: LazyPageNotFound,
  scrollRestoration: true,
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

whenSettled(() => {
  import("./components/route-error").catch(() => undefined);
});
