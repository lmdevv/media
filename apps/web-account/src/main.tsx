import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import { showsLinkSecret, takeLinkSecret } from "./session/link-secret";
import { makeOriginStore } from "./session/origin";
import { routeTree } from "./routeTree.gen";

const linkSecret = takeLinkSecret(window.location, window.history);

// A link opened over a page already showing changes only the hash, which loads nothing; loading
// the page again takes its secret before the router starts.
window.addEventListener("hashchange", () => {
  if (showsLinkSecret(window.location)) window.location.reload();
});

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  context: {
    origin: makeOriginStore(window.localStorage, window),
    linkSecret,
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
