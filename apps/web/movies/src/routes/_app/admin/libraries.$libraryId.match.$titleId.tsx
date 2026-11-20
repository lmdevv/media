import { createFileRoute } from "@tanstack/react-router";

import { FixMatchScreen, FixMatchSkeleton, preloadFixMatch } from "@/components/admin/fix-match";
import { parseLibraryId, parseTitleId } from "@/components/admin/route-params";
import { ScopeGate } from "@/components/admin/scope-gate";

export const Route = createFileRoute("/_app/admin/libraries/$libraryId/match/$titleId")({
  params: {
    parse: (raw) => ({
      libraryId: parseLibraryId(raw.libraryId),
      titleId: parseTitleId(raw.titleId),
    }),
    stringify: (params) => ({ libraryId: params.libraryId, titleId: params.titleId }),
  },
  head: () => ({ meta: [{ title: "Fix match · Lar Movies" }] }),
  loader: ({ context: { platform }, params }) => preloadFixMatch(platform, params),
  pendingComponent: FixMatchSkeleton,
  component: FixMatchPage,
});

function FixMatchPage() {
  const { libraryId, titleId } = Route.useParams();

  return (
    <ScopeGate access="edit">
      <FixMatchScreen key={titleId} libraryId={libraryId} titleId={titleId} />
    </ScopeGate>
  );
}
