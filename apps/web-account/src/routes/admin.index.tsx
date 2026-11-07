import { createFileRoute } from "@tanstack/react-router";

import { UsersScreen } from "@/components/admin/users";

export const Route = createFileRoute("/admin/")({
  head: () => ({ meta: [{ title: "Users · [media]" }] }),
  component: UsersScreen,
});
