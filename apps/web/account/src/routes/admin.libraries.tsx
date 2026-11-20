import { preloadFirstPage } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";

import { LibrariesScreen, LibrariesSkeleton } from "@/components/admin/libraries";
import { pageArgs } from "@/components/admin/parts";

export const Route = createFileRoute("/admin/libraries")({
  head: () => ({ meta: [{ title: "Libraries · Lar" }] }),
  loader: ({ context: { platform } }) => preloadFirstPage(platform.core.libraries.list, pageArgs),
  pendingComponent: LibrariesSkeleton,
  component: LibrariesScreen,
});
