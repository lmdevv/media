import { preloadFirstPage } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";

import { DevicesScreen, DevicesSkeleton } from "@/components/admin/devices";
import { pageArgs } from "@/components/admin/parts";

export const Route = createFileRoute("/admin/devices")({
  head: () => ({ meta: [{ title: "Shared devices · Lar" }] }),
  loader: ({ context: { platform } }) =>
    preloadFirstPage(platform.core.devices.registry.list, pageArgs),
  pendingComponent: DevicesSkeleton,
  component: DevicesScreen,
});
