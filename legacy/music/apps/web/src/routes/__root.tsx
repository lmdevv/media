import { CatchBoundary, HeadContent, Outlet, createRootRoute } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { Suspense, lazy } from "react";

import { LazyRouteError } from "@/components/lazy-route-error";

import "../index.css";

const Toaster = lazy(async () => ({
  default: (await import("@music/ui/components/sonner")).Toaster,
}));

export const Route = createRootRoute({
  component: RootComponent,
  errorComponent: LazyRouteError,
  head: () => ({
    meta: [
      { title: "[music]" },
      { name: "description", content: "Your own music library, streamed from your server" },
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
