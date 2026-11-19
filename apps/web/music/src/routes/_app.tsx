import { PlayerProvider } from "@media/player/react";
import { Outlet, createFileRoute } from "@tanstack/react-router";

import { GuestLinksProvider } from "@/components/guests/guest-links";
import { CastProvider } from "@/casting/cast-provider";
import { AppShell } from "@/components/shell/app-shell";
import { MEDIA_BASE_URL } from "@/env";

export const Route = createFileRoute("/_app")({ component: AppLayout });

/** The signed-in shell: the player for this browser, and its Chromecast, around every screen. */
function AppLayout() {
  return (
    <PlayerProvider mediaBaseUrl={MEDIA_BASE_URL}>
      <CastProvider>
        <GuestLinksProvider>
          <AppShell>
            <Outlet />
          </AppShell>
        </GuestLinksProvider>
      </CastProvider>
    </PlayerProvider>
  );
}
