import { createFileRoute } from "@tanstack/react-router";

import { LibrariesScreen } from "@/components/admin/libraries";

export const Route = createFileRoute("/admin/libraries")({
  head: () => ({ meta: [{ title: "Libraries · [media]" }] }),
  component: LibrariesScreen,
});
