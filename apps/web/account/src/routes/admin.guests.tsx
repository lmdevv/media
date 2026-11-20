import { preloadFirstPage } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";

import { GuestsScreen, GuestsSkeleton, everyoneLinks } from "@/components/admin/guests";

export const Route = createFileRoute("/admin/guests")({
  head: () => ({ meta: [{ title: "Guests · Lar" }] }),
  loader: async ({ context: { platform } }) => {
    await Promise.all([
      platform.core.guests.status.preload(),
      preloadFirstPage(platform.core.guests.links.list, everyoneLinks),
    ]);
  },
  pendingComponent: GuestsSkeleton,
  component: GuestsScreen,
});
