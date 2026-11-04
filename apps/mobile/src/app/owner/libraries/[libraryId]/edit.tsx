import { LibraryId } from "@media/contracts/ids";
import type { LibraryDetail } from "@media/contracts/models/catalog";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";

import { LibraryForm } from "@/components/owner/library-form";
import { OwnerScreen, QueryView } from "@/components/owner/parts";
import { draftOf, submission } from "@/lib/library-form";

const decodeLibraryId = Schema.decodeUnknownSync(LibraryId);

function EditForm({ library }: { readonly library: LibraryDetail }) {
  const update = useCommand("libraries.update");

  return (
    <LibraryForm
      title={library.name}
      initial={draftOf(library)}
      chooseKind={false}
      submitLabel="Save"
      onSubmit={async (draft) => {
        const { name, roots } = submission(draft);
        const moved = roots.join("\n") !== library.roots.join("\n");

        await update(
          moved ? { libraryId: library.id, name, roots } : { libraryId: library.id, name },
        );

        if (moved) {
          router.replace({
            pathname: "/owner/libraries/[libraryId]/scan",
            params: { libraryId: library.id },
          });

          return;
        }

        router.back();
      }}
    />
  );
}

export default function EditLibrary() {
  const params = useLocalSearchParams<{ libraryId: string }>();

  const library = useCommandQuery("libraries.get", {
    libraryId: decodeLibraryId(params.libraryId),
  });

  if (library.status === "success") return <EditForm library={library.data} />;

  return (
    <OwnerScreen title="Library">
      <QueryView query={library}>{() => null}</QueryView>
    </OwnerScreen>
  );
}
