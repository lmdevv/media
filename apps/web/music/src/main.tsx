import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/geist-mono/index.css";

import { openBrowserSession } from "@media/ui/lib/browser-session";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { LazyPageNotFound, LazyRouteError } from "./components/lazy-route-error";
import { PLATFORM_URL } from "./env";
import { parseSearch, stringifySearch } from "./lib/search-params";
import { whenSettled } from "./lib/when-settled";
import { routeTree } from "./routeTree.gen";
import { MusicSession, RequireSession } from "./session/session";

/** The origin's one session store, shared with the account client at `/` (ADR 0020). */
const store = await openBrowserSession();

const router = createRouter({
  routeTree,
  basepath: import.meta.env.BASE_URL,
  defaultPreload: "intent",
  defaultErrorComponent: LazyRouteError,
  defaultNotFoundComponent: LazyPageNotFound,
  scrollRestoration: true,
  parseSearch,
  stringifySearch,
  Wrap: function Providers({ children }: { readonly children: ReactNode }) {
    return (
      <MusicSession store={store} url={PLATFORM_URL}>
        <RequireSession>{children}</RequireSession>
      </MusicSession>
    );
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
