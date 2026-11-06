import { createFileRoute } from "@tanstack/react-router";

import { GroupsScreen } from "@/components/admin/groups";

export const Route = createFileRoute("/admin/groups")({
  head: () => ({ meta: [{ title: "Groups · [media]" }] }),
  component: GroupsScreen,
});
