import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/geist-mono/index.css";

import { ConvexAuthProvider } from "@convex-dev/auth/react";
import {
  RouterProvider,
  createRouter,
  parseSearchWith,
  stringifySearchWith,
} from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { resolveConvexUrl } from "./config";
import { routeTree } from "./routeTree.gen";

const convex = new ConvexReactClient(resolveConvexUrl());

const keepString = (value: string): string => value;

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
  // Search values stay plain strings; each route parses its own with a schema.
  parseSearch: parseSearchWith(keepString),
  stringifySearch: stringifySearchWith(keepString),
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
