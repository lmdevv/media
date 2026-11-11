import { Toaster } from "@media/ui/components/sonner";
import { HeadContent, createRootRouteWithContext } from "@tanstack/react-router";

import { PLATFORM_URL } from "@/env";
import { AccountProvider } from "@/session/account";
import type { BrowserStore } from "@media/ui/lib/browser-session";
import { Gate } from "@/session/gate";
import type { LinkSecret } from "@/session/link-secret";
import type { Need } from "@/session/screen";

import "../index.css";

/** What every route can read from the router context. */
export interface RouterAppContext {
  readonly store: BrowserStore;
  /** The secret of the invite or reset link this page opened with, taken out of the address. */
  readonly linkSecret: LinkSecret | null;
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** What the page needs before it shows; `anyone` when left out. */
    readonly need?: Need;
    /** The routes whose screen the gate draws: the picker and a tile's lock. */
    readonly intent?: "picker" | "tile";
  }
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [{ title: "[media]" }, { name: "description", content: "Your [media] account" }],
  }),
});

function RootComponent() {
  const { store } = Route.useRouteContext();

  return (
    <>
      <HeadContent />
      <AccountProvider store={store} url={PLATFORM_URL}>
        <Gate />
      </AccountProvider>
      <Toaster />
    </>
  );
}
