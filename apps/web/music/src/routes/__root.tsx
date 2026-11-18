import { CatchBoundary, HeadContent, Outlet, createRootRoute } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { Suspense, lazy } from "react";

import { LazyRouteError } from "@/components/lazy-route-error";

import "../index.css";

const Toaster = lazy(async () => ({
  default: (await import("@/components/ui/sonner")).Toaster,
}));

export const Route = createRootRoute({
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
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="music-theme"
      scriptProps={{ type: "application/json" }}
    >
      <HeadContent />
      <Outlet />
      <CatchBoundary getResetKey={() => 0} errorComponent={NoToaster}>
        <Suspense fallback={null}>
          <Toaster />
        </Suspense>
      </CatchBoundary>
    </ThemeProvider>
  );
}
