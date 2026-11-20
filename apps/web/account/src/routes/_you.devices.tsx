import { preloadFirstPage } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";

import { pageArgs } from "@/components/admin/parts";
import { DevicesScreen, DevicesSkeleton } from "@/screens/people/credentials";

export const Route = createFileRoute("/_you/devices")({
  head: () => ({ meta: [{ title: "Devices · Lar" }] }),
  loader: ({ context: { platform } }) =>
    preloadFirstPage(platform.core.auth.sessions.list, pageArgs),
  pendingComponent: DevicesSkeleton,
  component: DevicesScreen,
});
