import { usePlatform } from "@media/sdk/react";
import { router } from "expo-router";

import { LibraryForm } from "@/components/owner/library-form";
import { NEW_DRAFT, submission } from "@/lib/library-form";

export default function AddLibrary() {
  const platform = usePlatform();

  return (
    <LibraryForm
      title="Add Library"
      initial={NEW_DRAFT}
      submitLabel="Add & Scan"
      onSubmit={async (draft) => {
        const created = await platform.core.libraries.create({
          ...submission(draft),
          kind: "movies",
        });

        router.replace({
          pathname: "/owner/libraries/[libraryId]/scan",
          params: { libraryId: created.libraryId },
        });
      }}
    />
  );
}
