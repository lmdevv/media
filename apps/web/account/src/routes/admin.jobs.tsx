import { preloadFirstPage } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";

import { JobsScreen, JobsSkeleton, failedArgs } from "@/components/admin/jobs";
import { pageArgs } from "@/components/admin/parts";

export const Route = createFileRoute("/admin/jobs")({
  head: () => ({ meta: [{ title: "Jobs · Lar" }] }),
  loader: async ({ context: { platform } }) => {
    void preloadFirstPage(platform.core.jobs.list, failedArgs);
    await preloadFirstPage(platform.core.jobs.list, pageArgs);
  },
  pendingComponent: JobsSkeleton,
  component: JobsScreen,
});
