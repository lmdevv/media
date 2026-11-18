import { router } from "expo-router";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { SheetLayout } from "@/components/ui/sheet-layout";
import type { LibraryId } from "@/lib/ids";
import { useCore } from "@/lib/platform";

import { useLibrary } from "./data";
import { useLastKnown } from "./use-last-known";

/** The confirmation for removing a library, with its name. */
export function RemoveLibrarySheet({ id }: { readonly id: LibraryId | null }) {
  const library = useLastKnown(useLibrary(id));
  const core = useCore();

  if (library === undefined) return null;

  if (library === null) {
    return <SheetLayout title="Library not found" subtitle="It may have been removed already." />;
  }

  return (
    <ConfirmSheet
      title={`Remove ${library.name}?`}
      body="Its music will disappear from the library index. The original files stay on your server."
      confirmLabel="Remove library"
      pendingLabel="Removing…"
      cancelLabel="Keep library"
      onConfirm={async () => {
        await core.libraries.remove({ libraryId: library.libraryId });
        router.dismissTo("/settings/admin/libraries");
      }}
    />
  );
}
