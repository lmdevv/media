import { createFileRoute } from "@tanstack/react-router";

import { LibrariesScreen } from "@/components/admin/libraries";
import { ScopeGate } from "@/components/admin/scope-gate";

export const Route = createFileRoute("/_app/admin/libraries/")({
  head: () => ({ meta: [{ title: "Libraries · Lar Movies" }] }),
  component: () => (
    <ScopeGate access="edit">
      <LibrariesScreen />
    </ScopeGate>
  ),
});
