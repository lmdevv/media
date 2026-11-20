import type { PlatformSdk } from "@media/sdk/promise";
import { useFocusPolicy } from "@media/ui/lib/focus-policy";
import {
  CatchBoundary,
  HeadContent,
  Outlet,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { Suspense, lazy } from "react";

import { RequireSession } from "@/session/session";

import { LazyRouteError } from "@/components/lazy-route-error";

import "../index.css";

const Toaster = lazy(async () => ({
  default: (await import("@/components/ui/sonner")).Toaster,
}));

/** What every route can read from the router context. */
export interface RouterAppContext {
  /** The page's platform client, which route loaders preload into for the screens they open. */
  readonly platform: PlatformSdk;
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  errorComponent: LazyRouteError,
  head: () => ({
    meta: [
      { title: "Lar Music" },
      { name: "description", content: "Your own music library, streamed from your server" },
    ],
    links: [
      { rel: "icon", href: `${import.meta.env.BASE_URL}favicon.ico`, sizes: "48x48" },
      { rel: "icon", href: `${import.meta.env.BASE_URL}favicon.svg`, type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: `${import.meta.env.BASE_URL}apple-touch-icon.png` },
      { rel: "manifest", href: `${import.meta.env.BASE_URL}manifest.webmanifest` },
    ],
  }),
});

const NoToaster = () => null;

function RootComponent() {
  useFocusPolicy();

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="music-theme"
      scriptProps={{ type: "application/json" }}
    >
      <HeadContent />
      <RequireSession>
        <Outlet />
      </RequireSession>
      <CatchBoundary getResetKey={() => 0} errorComponent={NoToaster}>
        <Suspense fallback={null}>
          <Toaster />
        </Suspense>
      </CatchBoundary>
    </ThemeProvider>
  );
}
