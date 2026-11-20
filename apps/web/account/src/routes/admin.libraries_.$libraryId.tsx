import { createFileRoute } from "@tanstack/react-router";
import { Brand } from "effect";

import { LibrariesCrumb, LibraryScreen, LibrarySkeleton } from "@/components/admin/library";
import type { LibraryId } from "@/components/admin/types";

const libraryId = Brand.nominal<LibraryId>();

function Library() {
  const params = Route.useParams();

  return <LibraryScreen key={params.libraryId} libraryId={libraryId(params.libraryId)} />;
}

export const Route = createFileRoute("/admin/libraries_/$libraryId")({
  head: () => ({ meta: [{ title: "Library · Lar" }] }),
  loader: ({ context: { platform }, params }) =>
    platform.core.libraries.get.preload({ libraryId: libraryId(params.libraryId) }),
  pendingComponent: () => <LibrarySkeleton back={<LibrariesCrumb />} />,
  component: Library,
});
