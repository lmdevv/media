import { Toaster } from "@music/ui/components/sonner";
import { TooltipProvider } from "@music/ui/components/tooltip";
import { HeadContent, Outlet, createRootRoute } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";

import { RouteError } from "@/components/route-error";

import "../index.css";

export const Route = createRootRoute({
  component: RootComponent,
  errorComponent: RouteError,
  head: () => ({
    meta: [
      { title: "[music]" },
      { name: "description", content: "Your own music library, streamed from your server" },
    ],
  }),
});

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
      <TooltipProvider>
        <HeadContent />
        <Outlet />
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}
