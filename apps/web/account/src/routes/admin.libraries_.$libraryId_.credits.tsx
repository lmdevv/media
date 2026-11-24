import { createFileRoute } from "@tanstack/react-router";
import { Brand } from "effect";

import { CreditsScreen, CreditsSkeleton, preloadCreditLists } from "@/components/admin/credits";
import { LibrariesCrumb } from "@/components/admin/library";
import type { LibraryId } from "@/components/admin/types";

const libraryId = Brand.nominal<LibraryId>();

function Credits() {
  const params = Route.useParams();

  return <CreditsScreen key={params.libraryId} libraryId={libraryId(params.libraryId)} />;
}

export const Route = createFileRoute("/admin/libraries_/$libraryId_/credits")({
  head: () => ({ meta: [{ title: "Artist credits · Lar" }] }),
  loader: async ({ context: { platform }, params }) => {
    const id = libraryId(params.libraryId);

    // The lists a manager's page shows, started with the library, which decides what the page holds.
    preloadCreditLists(platform, id);
    await platform.core.libraries.get.preload({ libraryId: id });
  },
  pendingComponent: () => <CreditsSkeleton back={<LibrariesCrumb />} />,
  component: Credits,
});
