import { preloadFirstPage } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";

import { pageArgs } from "@/components/admin/parts";
import { SettingsFrame } from "@/components/shell";
import { DevicesScreen, DevicesSkeleton } from "@/screens/people/credentials";

export const Route = createFileRoute("/devices")({
  staticData: { need: "account" },
  head: () => ({ meta: [{ title: "Devices · Lar" }] }),
  loader: ({ context: { platform } }) =>
    preloadFirstPage(platform.core.auth.sessions.list, pageArgs),
  pendingComponent: () => (
    <SettingsFrame>
      <DevicesSkeleton />
    </SettingsFrame>
  ),
  component: () => (
    <SettingsFrame>
      <DevicesScreen />
    </SettingsFrame>
  ),
});
