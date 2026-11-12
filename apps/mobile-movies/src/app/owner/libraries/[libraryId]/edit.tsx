import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { router, useLocalSearchParams } from "expo-router";

import { LibraryForm } from "@/components/owner/library-form";
import { OwnerScreen, QueryView } from "@/components/owner/parts";
import { draftOf, submission } from "@/lib/library-form";
import { asLibraryId } from "@/lib/owner";
import type { LibraryDetail } from "@/lib/owner";

function EditForm({ library }: { readonly library: LibraryDetail }) {
  const platform = usePlatform();
  const { libraryId } = library;
  const saved = library.folders ?? [];

  return (
    <LibraryForm
      title={library.name}
      initial={draftOf(library)}
      submitLabel="Save"
      onSubmit={async (draft) => {
        const { name, folders } = submission(draft);
        const moved = folders.join("\n") !== saved.join("\n");

        if (name !== library.name) await platform.core.libraries.rename({ libraryId, name });

        const rescan = moved
          ? (await platform.core.libraries.setFolders({ libraryId, folders })).scanJobId
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
