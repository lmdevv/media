import { preloadFirstPage } from "@media/ui/lib/pages";
import { createFileRoute } from "@tanstack/react-router";
import { Brand } from "effect";

import { LibrariesCrumb, LibraryScreen, LibrarySkeleton } from "@/components/admin/library";
import { pageArgs } from "@/components/admin/parts";
import { grantArgs } from "@/components/admin/sharing";
import type { LibraryId } from "@/components/admin/types";

const libraryId = Brand.nominal<LibraryId>();

function Library() {
  const params = Route.useParams();

  return <LibraryScreen key={params.libraryId} libraryId={libraryId(params.libraryId)} />;
}

export const Route = createFileRoute("/admin/libraries_/$libraryId")({
  head: () => ({ meta: [{ title: "Library · Lar" }] }),
  loader: async ({ context: { platform }, params }) => {
    const id = libraryId(params.libraryId);

    // What Sharing reads, started with the library so a manager's page opens with it.
    void preloadFirstPage(platform.core.permissions.grants.list, grantArgs(id));
    void preloadFirstPage(platform.core.accounts.users.list, pageArgs);
    void preloadFirstPage(platform.core.permissions.groups.list, pageArgs);
    await platform.core.libraries.get.preload({ libraryId: id });
  },
  pendingComponent: () => <LibrarySkeleton back={<LibrariesCrumb />} />,
  component: Library,
});
