import { createPlatform } from "@media/sdk/promise";
import { Spinner } from "@media/ui/components/spinner";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import ReactDOM from "react-dom/client";

import { NotFoundPage, RouteErrorPage } from "./components/shell/route-states";
import { openBrowserSession } from "@media/ui/lib/browser-session";

import { PLATFORM_URL, SIGN_IN_URL } from "./env";
import { parseSearch, stringifySearch } from "./lib/search-params";
import { routeTree } from "./routeTree.gen";
import { ReportUnhandledErrors } from "./session/error-reporting";
import { MoviesSession } from "./session/session";

/** The origin's one session store, shared with the account client at `/` (ADR 0020). */
const store = await openBrowserSession();

/** The page's one platform client, which route loaders and screens share. */
const platform = createPlatform({
  url: PLATFORM_URL,
  signInUrl: SIGN_IN_URL,
  storage: store.sessions,
});

const router = createRouter({
  routeTree,
  basepath: import.meta.env.BASE_URL,
  defaultPreload: "intent",
  // A page stays on screen while the next one's loader runs; past 300 ms the next one's skeleton
  // shows, for at least 300 ms so it never flashes.
  defaultPendingMs: 300,
  defaultPendingMinMs: 300,
  scrollRestoration: true,
  parseSearch,
  stringifySearch,
  defaultNotFoundComponent: NotFoundPage,
  defaultErrorComponent: RouteErrorPage,
  defaultPendingComponent: () => (
    <div className="flex min-h-svh items-center justify-center bg-page">
      <Spinner className="size-12 text-text" label="Loading" />
    </div>
  ),
  context: { platform },
  Wrap: function Providers({ children }: { readonly children: ReactNode }) {
    return (
      <MoviesSession platform={platform}>
        <ReportUnhandledErrors />
        {children}
      </MoviesSession>
    );
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Root element not found");
}

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}
