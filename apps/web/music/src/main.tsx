import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/geist-mono/index.css";

import { createPlatform } from "@media/sdk/promise";
import { openBrowserSession } from "@media/ui/lib/browser-session";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { LazyPageNotFound, LazyRouteError } from "./components/lazy-route-error";
import { PLATFORM_URL, SIGN_IN_URL } from "./env";
import { parseSearch, stringifySearch } from "./lib/search-params";
import { whenSettled } from "./lib/when-settled";
import { routeTree } from "./routeTree.gen";
import { MusicSession } from "./session/session";

/** The origin's one session store, shared with the account client at `/` (ADR 0020). */
const store = await openBrowserSession();

const platform = createPlatform({
  url: PLATFORM_URL,
  signInUrl: SIGN_IN_URL,
  storage: store.sessions,
});

const router = createRouter({
  routeTree,
  context: { platform },
  basepath: import.meta.env.BASE_URL,
  defaultPreload: "intent",
  defaultPendingMs: 300,
  defaultPendingMinMs: 300,
  defaultErrorComponent: LazyRouteError,
  defaultNotFoundComponent: LazyPageNotFound,
  scrollRestoration: true,
  parseSearch,
  stringifySearch,
  Wrap: function Providers({ children }: { readonly children: ReactNode }) {
    return <MusicSession platform={platform}>{children}</MusicSession>;
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
