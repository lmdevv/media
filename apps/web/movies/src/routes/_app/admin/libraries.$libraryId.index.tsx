import { createFileRoute } from "@tanstack/react-router";

import {
  LibraryDetailScreen,
  LibraryDetailSkeleton,
  preloadLibraryDetail,
} from "@/components/admin/library-detail";
import { parseLibraryId } from "@/components/admin/route-params";
import { ScopeGate } from "@/components/admin/scope-gate";

export const Route = createFileRoute("/_app/admin/libraries/$libraryId/")({
  params: {
    parse: (raw) => ({ libraryId: parseLibraryId(raw.libraryId) }),
    stringify: (params) => ({ libraryId: params.libraryId }),
  },
  head: () => ({ meta: [{ title: "Library · Lar Movies" }] }),
  loader: ({ context: { platform }, params: { libraryId } }) =>
    preloadLibraryDetail(platform, libraryId),
  pendingComponent: LibraryDetailSkeleton,
  component: LibraryDetailPage,
});

function LibraryDetailPage() {
  const { libraryId } = Route.useParams();

  return (
    <ScopeGate access="edit">
      <LibraryDetailScreen key={libraryId} libraryId={libraryId} />
    </ScopeGate>
  );
}
