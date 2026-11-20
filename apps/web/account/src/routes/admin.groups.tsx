import { preloadFirstPage } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";

import { GroupsScreen, GroupsSkeleton } from "@/components/admin/groups";
import { pageArgs } from "@/components/admin/parts";

export const Route = createFileRoute("/admin/groups")({
  head: () => ({ meta: [{ title: "Groups · Lar" }] }),
  loader: ({ context: { platform } }) =>
    preloadFirstPage(platform.core.permissions.groups.list, pageArgs),
  pendingComponent: GroupsSkeleton,
  component: GroupsScreen,
});
