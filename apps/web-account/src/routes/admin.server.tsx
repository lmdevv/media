import { createFileRoute } from "@tanstack/react-router";

import { ServerScreen } from "@/components/admin/server";
import { MEDIA_BASE_URL, PLATFORM_URL } from "@/env";

export const Route = createFileRoute("/admin/server")({
  head: () => ({ meta: [{ title: "Server · [media]" }] }),
  component: () => <ServerScreen mediaUrl={MEDIA_BASE_URL} databaseUrl={PLATFORM_URL} />,
});
