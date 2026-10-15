import { CatchBoundary, HeadContent, Outlet, createRootRoute } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { Suspense, lazy } from "react";

import { LazyRouteError } from "@/components/lazy-route-error";

import "../index.css";

// Toasts and the error screen load beside the first screen rather than in front of it. A toast
// raised before the Toaster mounts still shows: it replays the toasts that are active when it
// subscribes.
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
      // React never runs scripts it renders on the client; index.html sets the theme before paint.
      scriptProps={{ type: "application/json" }}
    >
      <HeadContent />
      <Outlet />
      {/* Without its chunk there are no toasts, but the app (and the music) carries on. */}
      <CatchBoundary getResetKey={() => 0} errorComponent={NoToaster}>
        <Suspense fallback={null}>
          <Toaster />
        </Suspense>
      </CatchBoundary>
    </ThemeProvider>
  );
}
