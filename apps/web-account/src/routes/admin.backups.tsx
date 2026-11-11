import { createFileRoute } from "@tanstack/react-router";

import { BackupsScreen } from "@/components/admin/backups";
import { MEDIA_BASE_URL } from "@/env";

export const Route = createFileRoute("/admin/backups")({
  head: () => ({ meta: [{ title: "Backups · [media]" }] }),
  component: () => <BackupsScreen mediaUrl={MEDIA_BASE_URL} />,
});
