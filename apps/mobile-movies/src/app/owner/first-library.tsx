import { usePlatform } from "@media/sdk/react";
import { router } from "expo-router";
import { useEffect } from "react";

import { LibraryForm } from "@/components/owner/library-form";
import { useTask } from "@/components/owner/use-task";
import { Button } from "@/components/ui/button";
import { NEW_DRAFT, submission } from "@/lib/library-form";
import { useFinishSetup } from "@/session/finish-setup";
import { useFirstRun } from "@/session/first-run";
import { useSessionPhase } from "@/session/session-phase";

export default function AddYourFirstLibrary() {
  const platform = usePlatform();
  const firstRun = useFirstRun();
  const finishSetup = useFinishSetup();
  const phase = useSessionPhase();

  const later = useTask(async () => {
    if (phase.kind === "setup") await finishSetup();
    else router.back();
  });

  const { start, startedImport } = firstRun;

  useEffect(() => {
    if (start !== "import") return;
    startedImport();
    router.push("/owner/import");
  }, [start, startedImport]);

  return (
    <LibraryForm
      title="Add Your First Library"
      initial={NEW_DRAFT}
      submitLabel="Add & Scan"
      checkButton={false}
      back={false}
      onSubmit={async (draft) => {
        const created = await platform.core.libraries.create({
          ...submission(draft),
          kind: "movies",
        });

        router.push({
          pathname: "/owner/libraries/[libraryId]/scan",
          params: { libraryId: created.libraryId },
        });
      }}
      secondary={
        <Button
          label="Set Up Later"
          variant="secondary"
          busy={later.busy}
          onPress={() => void later.run()}
        />
      }
    />
  );
}
