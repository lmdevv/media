import { preloadFirstPage } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";

import { LibrariesScreen, LibrariesSkeleton } from "@/components/admin/libraries";
import { ScopeGate } from "@/components/admin/scope-gate";
import { librariesPage } from "@/lib/libraries";

export const Route = createFileRoute("/_app/admin/libraries/")({
  head: () => ({ meta: [{ title: "Libraries · Lar Movies" }] }),
  loader: ({ context: { platform } }) =>
    preloadFirstPage(platform.core.libraries.list, librariesPage),
  pendingComponent: LibrariesSkeleton,
  component: () => (
    <ScopeGate access="edit">
      <LibrariesScreen />
    </ScopeGate>
  ),
});
