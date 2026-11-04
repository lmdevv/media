import { MoviesProvider } from "@media/sdk/react";
import { Spinner } from "@media/ui/components/spinner";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import ReactDOM from "react-dom/client";

import { NotFoundPage, RouteErrorPage } from "./components/shell/route-states";
import { ENV, MEDIA_BASE_URL } from "./env";
import { loadLogLevel } from "./lib/device-storage";
import { parseSearch, stringifySearch } from "./lib/search-params";
import { routeTree } from "./routeTree.gen";
import { ReportUnhandledErrors } from "./session/error-reporting";
import { ProfileChoiceProvider } from "./session/profile-choice";

const convex = new ConvexReactClient(ENV.VITE_CONVEX_URL);

const logLevel = loadLogLevel();

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
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
  context: {},
  Wrap: function Providers({ children }: { readonly children: ReactNode }) {
    return (
      <MoviesProvider
        client={convex}
        storage={window.localStorage}
        mediaUrl={MEDIA_BASE_URL}
        logLevel={logLevel}
      >
        <ReportUnhandledErrors />
        <ProfileChoiceProvider>{children}</ProfileChoiceProvider>
      </MoviesProvider>
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
