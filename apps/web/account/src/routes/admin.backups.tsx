import { preloadFirstPage } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";

import { BackupsScreen, BackupsSkeleton } from "@/components/admin/backups";
import { pageArgs } from "@/components/admin/parts";
import { MEDIA_BASE_URL } from "@/env";

export const Route = createFileRoute("/admin/backups")({
  head: () => ({ meta: [{ title: "Backups · Lar" }] }),
  loader: async ({ context: { platform } }) => {
    const { backups } = platform.core.server;

    await Promise.all([backups.active.preload({}), preloadFirstPage(backups.list, pageArgs)]);
  },
  pendingComponent: BackupsSkeleton,
  component: () => <BackupsScreen mediaUrl={MEDIA_BASE_URL} />,
});
