import { preloadFirstPage } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";

import { pageArgs } from "@/components/admin/parts";
import { UsersScreen, UsersSkeleton } from "@/components/admin/users";

export const Route = createFileRoute("/admin/")({
  head: () => ({ meta: [{ title: "Users · Lar" }] }),
  loader: ({ context: { platform } }) =>
    preloadFirstPage(platform.core.accounts.users.list, pageArgs),
  pendingComponent: UsersSkeleton,
  component: UsersScreen,
});
