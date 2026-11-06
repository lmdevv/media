import { createFileRoute } from "@tanstack/react-router";

import { DevicesScreen } from "@/components/admin/devices";

export const Route = createFileRoute("/admin/devices")({
  head: () => ({ meta: [{ title: "Shared devices · [media]" }] }),
  component: DevicesScreen,
});
