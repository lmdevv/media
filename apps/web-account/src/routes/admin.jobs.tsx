import { createFileRoute } from "@tanstack/react-router";

import { JobsScreen } from "@/components/admin/jobs";

export const Route = createFileRoute("/admin/jobs")({
  head: () => ({ meta: [{ title: "Jobs · [media]" }] }),
  component: JobsScreen,
});
