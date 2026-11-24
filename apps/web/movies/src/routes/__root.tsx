import type { PlatformSdk } from "@media/sdk/promise";
import { Toaster } from "@media/ui/components/sonner";
import { shortcutOptions, useFocusPolicy } from "@media/ui/lib/focus-policy";
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import type { HotkeysProviderOptions } from "@tanstack/react-hotkeys";
import { HeadContent, Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { MoviesAccess } from "@/session/access";
import { ThemeColor } from "@/components/theme-color";
import { ThemeProvider } from "@/components/theme-provider";

import "../index.css";

/** Values every route can read from the router context. */
export interface RouterAppContext {
  /** The page's platform client, which route loaders preload into for the screens they open. */
  readonly platform: PlatformSdk;
}

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
      { title: "Lar Movies" },
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

const SHORTCUTS: HotkeysProviderOptions = {
  hotkey: { ...shortcutOptions, target: window, requireReset: true, timeout: 1_000 },
};

function RootComponent() {
  useFocusPolicy();

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
        <HotkeysProvider defaultOptions={SHORTCUTS}>
          <MoviesAccess>
            <Outlet />
          </MoviesAccess>
        </HotkeysProvider>
        <Toaster />
      </ThemeProvider>
      {import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-left" /> : null}
    </>
  );
}
