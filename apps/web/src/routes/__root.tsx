import { Toaster } from "@media/ui/components/sonner";
import { HeadContent, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { ThemeColor } from "@/components/theme-color";
import { ThemeProvider } from "@/components/theme-provider";

import "../index.css";

/** Values every route can read from the router context. */
export interface RouterAppContext {}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The route opens on a full-bleed billboard, so the desktop top bar floats over it. */
    readonly hero?: boolean;
    /** Set to false for phone screens without the large title, such as a title's detail page. */
    readonly phoneTitle?: boolean;
  }
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      { title: "[movies]" },
      { name: "description", content: "Your movies and shows, streamed from your own library" },
    ],
    links: [
      { rel: "icon", href: `${import.meta.env.BASE_URL}favicon.ico`, sizes: "48x48" },
      { rel: "icon", href: `${import.meta.env.BASE_URL}favicon.svg`, type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: `${import.meta.env.BASE_URL}apple-touch-icon.png` },
      { rel: "manifest", href: `${import.meta.env.BASE_URL}manifest.webmanifest` },
    ],
  }),
});

function RootComponent() {
  return (
    <>
      <HeadContent />
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        disableTransitionOnChange
        storageKey="movies-theme"
        // React never runs scripts it renders on the client; index.html applies the theme before paint.
        scriptProps={{ type: "application/json" }}
      >
        <ThemeColor />
        <Outlet />
        <Toaster />
      </ThemeProvider>
      {import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-left" /> : null}
    </>
  );
}
