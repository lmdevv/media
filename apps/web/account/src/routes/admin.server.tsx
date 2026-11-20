import { createFileRoute } from "@tanstack/react-router";

import { ServerScreen, ServerSkeleton } from "@/components/admin/server";
import { MEDIA_BASE_URL, PLATFORM_URL } from "@/env";

export const Route = createFileRoute("/admin/server")({
  head: () => ({ meta: [{ title: "Server · Lar" }] }),
  loader: ({ context: { platform } }) => platform.core.server.status.preload({}),
  pendingComponent: () => <ServerSkeleton mediaUrl={MEDIA_BASE_URL} />,
  component: () => <ServerScreen mediaUrl={MEDIA_BASE_URL} databaseUrl={PLATFORM_URL} />,
});
