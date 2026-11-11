import { useCommand } from "@media/sdk/react";
import { router } from "expo-router";

import { LibraryForm } from "@/components/owner/library-form";
import { NEW_DRAFT, submission } from "@/lib/library-form";

export default function AddLibrary() {
  const create = useCommand("libraries.create");

  return (
    <LibraryForm
      title="Add Library"
      initial={NEW_DRAFT}
      chooseKind
      submitLabel="Add & Scan"
      onSubmit={async (draft) => {
        const created = await create({ ...submission(draft), kind: draft.kind });

        router.replace({
          pathname: "/owner/libraries/[libraryId]/scan",
          params: { libraryId: created.libraryId, jobId: created.jobId },
        });
      }}
    />
  );
}
