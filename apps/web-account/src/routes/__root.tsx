import { Toaster } from "@media/ui/components/sonner";
import { HeadContent, createRootRouteWithContext, useRouterState } from "@tanstack/react-router";

import { PLATFORM_URL } from "@/env";
import { AccountProvider } from "@/session/account";
import { Gate } from "@/session/gate";
import type { OriginStore } from "@/session/origin";
import type { Need } from "@/session/screen";

import "../index.css";

/** What every route can read from the router context. */
export interface RouterAppContext {
  readonly origin: OriginStore;
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** What the page needs before it shows; `anyone` when left out. */
    readonly need?: Need;
    /** The routes whose screen the gate draws: the picker, adding someone, and a tile's lock. */
    readonly intent?: "picker" | "add" | "tile";
  }
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [{ title: "[media]" }, { name: "description", content: "Your [media] account" }],
  }),
});

function RootComponent() {
  const { origin } = Route.useRouteContext();

  const freshSlot = useRouterState({
    select: (state) =>
      state.matches.some(
        (match) => match.staticData.intent === "add" || match.staticData.need === "public",
      ),
  });

  return (
    <>
      <HeadContent />
      <AccountProvider store={origin} url={PLATFORM_URL} freshSlot={freshSlot}>
        <Gate />
      </AccountProvider>
      <Toaster />
    </>
  );
}
