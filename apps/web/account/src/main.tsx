import { createPlatform } from "@media/sdk/promise";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import { openBrowserSession } from "@media/ui/lib/browser-session";

import { PLATFORM_URL, SIGN_IN_URL } from "./env";
import { showsLinkSecret, takeLinkSecret } from "./session/link-secret";
import { routeTree } from "./routeTree.gen";

const linkSecret = takeLinkSecret(window.location, window.history);

// A link opened over a page already showing changes only the hash, which loads nothing; loading
// the page again takes its secret before the router starts.
window.addEventListener("hashchange", () => {
  if (showsLinkSecret(window.location)) window.location.reload();
});

const store = await openBrowserSession();

/** The page's one platform client, which route loaders and screens share. */
const platform = createPlatform({
  url: PLATFORM_URL,
  signInUrl: SIGN_IN_URL,
  storage: store.sessions,
});

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  // A page stays on screen while the next one's loader runs; past 300 ms the next one's skeleton
  // shows, for at least 300 ms so it never flashes.
  defaultPendingMs: 300,
  defaultPendingMinMs: 300,
  scrollRestoration: true,
  context: {
    store,
    linkSecret,
    platform,
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("app");

if (rootElement === null) throw new Error("Root element not found");

ReactDOM.createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
