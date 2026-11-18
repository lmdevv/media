import { anyEdited, overtakenFields } from "@media/mobile-core/edits";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";

import { confirmOverwrite } from "@/components/owner/confirm-overwrite";
import { LibraryForm } from "@/components/owner/library-form";
import { OwnerScreen, QueryView } from "@/components/owner/parts";
import { draftOf, fieldsOf, librarySave } from "@/lib/library-form";
import { asLibraryId } from "@/lib/owner";
import type { LibraryDetail } from "@/lib/owner";

function EditForm({ library }: { readonly library: LibraryDetail }) {
  const platform = usePlatform();
  const { libraryId } = library;
  // The library as the form opened it: a save writes only what the person changed from this.
  const [began] = useState(() => fieldsOf(library));

  return (
    <LibraryForm
      title={library.name}
      initial={draftOf(library)}
      submitLabel="Save"
      onSubmit={async (draft) => {
        const save = librarySave(began, draft, fieldsOf(library));

        if (!anyEdited([save.name, save.folders])) {
          router.back();

          return;
        }

        if (
          !(await confirmOverwrite(overtakenFields({ Name: save.name, Folders: save.folders })))
        ) {
          return;
        }

        if (save.name.kind === "edited") {
          await platform.core.libraries.rename({ libraryId, name: save.name.to });
        }

        const rescan =
          save.folders.kind === "edited"
            ? (await platform.core.libraries.setFolders({ libraryId, folders: save.folders.to }))
                .scanJobId
            : null;

        if (rescan !== null) {
          router.replace({ pathname: "/owner/libraries/[libraryId]/scan", params: { libraryId } });

          return;
        }

        router.back();
      }}
    />
  );
}

export default function EditLibrary() {
  const platform = usePlatform();
  const params = useLocalSearchParams<{ libraryId: string }>();

  const library = usePlatformQuery(platform.core.libraries.get, {
    libraryId: asLibraryId(params.libraryId),
  });

  if (library.status === "success") return <EditForm library={library.data} />;

  return (
    <OwnerScreen title="Library">
      <QueryView query={library}>{() => null}</QueryView>
    </OwnerScreen>
  );
}
