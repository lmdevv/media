import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import { openIndexedDb } from "@media/sdk/promise";

import { showsLinkSecret, takeLinkSecret } from "./session/link-secret";
import { openOriginStore } from "./session/origin";
import { routeTree } from "./routeTree.gen";

const linkSecret = takeLinkSecret(window.location, window.history);

// A link opened over a page already showing changes only the hash, which loads nothing; loading
// the page again takes its secret before the router starts.
window.addEventListener("hashchange", () => {
  if (showsLinkSecret(window.location)) window.location.reload();
});

/**
 * The browser's shared session store: IndexedDB, whose transactions run one at a time across tabs
 * and work over plain HTTP, with a `BroadcastChannel` telling the other tabs to read again.
 * Without it the browser keeps no sign-in rather than falling back to `localStorage`.
 */
const shared = await openIndexedDb({
  indexedDB: window.indexedDB,
  name: "media",
  channel: (name, onMessage) => {
    const channel = new BroadcastChannel(name);
    const announce = channel.postMessage.bind(channel);

    channel.addEventListener("message", onMessage);

    return { post: () => announce("changed"), close: () => channel.close() };
  },
}).catch(() => null);

const origin = await openOriginStore(shared);

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  context: {
    origin,
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
