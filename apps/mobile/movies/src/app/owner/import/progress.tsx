import type { ImportPhase } from "@media/contracts/models/migration";
import { SOURCE_NAMES } from "@media/contracts/migration-plan";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import {
  Bookmark,
  Check,
  Folder,
  FolderSearch,
  History,
  House,
  Library as LibraryIcon,
  Pencil,
  Play,
  RotateCcw,
  Users,
  X,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";

import { InlineState, Meter, OwnerScreen, QueryView } from "@/components/owner/parts";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { doneRows, importFraction, isRunning, phaseRows } from "@/lib/migration";
import type { CountRow } from "@/lib/migration";
import { asImportId } from "@/lib/owner";
import type { ImportId, ImportRun } from "@/lib/owner";
import { formatPercent } from "@/lib/owner-format";
import { useFinishSetup } from "@/session/finish-setup";
import { useSessionPhase } from "@/session/session-phase";

const PHASE_ICONS: Readonly<Record<ImportPhase, LucideIcon>> = {
  libraries: Folder,
  scanning: FolderSearch,
  watchState: History,
  collections: LibraryIcon,
  overrides: Pencil,
  done: Check,
};

const DONE_ICONS: Readonly<Record<CountRow["key"], LucideIcon>> = {
  libraries: Folder,
  users: Users,
  watched: History,
  inProgress: Play,
  favorites: Bookmark,
  collections: LibraryIcon,
};

const useGoHome = () => {
  const phase = useSessionPhase();
  const finishSetup = useFinishSetup();

  return () => {
    if (phase.kind === "setup") void finishSetup();
    else router.dismissTo("/");
  };
};

function Importing({ run }: { readonly run: ImportRun }) {
  const goHome = useGoHome();
  const fraction = importFraction(run);

  return (
    <>
      <Meter
        label={formatPercent(fraction)}
        value={fraction}
        accessibilityLabel={`Importing from ${SOURCE_NAMES[run.source]}, ${formatPercent(fraction)}`}
      />
      {phaseRows(run).map((row) => (
        <ListRow
          key={row.phase}
          icon={row.state === "done" ? Check : PHASE_ICONS[row.phase]}
          title={row.title}
          detail={row.detail}
        />
      ))}
      <Button label="Keep Browsing" variant="secondary" onPress={goHome} />
    </>
  );
}

function Complete({ run }: { readonly run: ImportRun }) {
  const goHome = useGoHome();

  return (
    <>
      <InlineState icon={Check} title="Import Complete" />
      {doneRows(run).map((row) => (
        <ListRow key={row.key} icon={DONE_ICONS[row.key]} title={row.title} detail={row.detail} />
      ))}
      <Button label="Browse Library" icon={House} onPress={goHome} />
    </>
  );
}

function Stopped({ run }: { readonly run: ImportRun }) {
  return (
    <>
      <InlineState
        icon={X}
        title="The Import Stopped"
        description={run.job.error ?? "It was cancelled before it finished."}
      />
      <Button
        label="Start Again"
        icon={RotateCcw}
        onPress={() => router.replace("/owner/import")}
      />
    </>
  );
}

const useLeaveImport = () => {
  const phase = useSessionPhase();

  return () => router.dismissTo(phase.kind === "setup" ? "/owner/first-library" : "/owner");
};

function RunView({ run }: { readonly run: ImportRun }) {
  if (run.job.status === "succeeded") return <Complete run={run} />;

  return isRunning(run) ? <Importing run={run} /> : <Stopped run={run} />;
}

function RunProgress({ importId }: { readonly importId: ImportId }) {
  const platform = usePlatform();
  const run = usePlatformQuery(platform.movies.imports.get, { importId });
  const leave = useLeaveImport();
  const done = run.status === "success" && run.data.job.status === "succeeded";

  return (
    <OwnerScreen title={done ? "Import Complete" : "Importing"} onBack={leave}>
      <QueryView query={run}>{(shown) => <RunView run={shown} />}</QueryView>
    </OwnerScreen>
  );
}

/**
 * The import a link names. One that names none goes to Import, which opens the import still
 * running, if any.
 */
export default function ImportProgress() {
  const params = useLocalSearchParams<{ importId?: string }>();

  if (params.importId === undefined || params.importId === "") {
    return <Redirect href="/owner/import" />;
  }

  return <RunProgress key={params.importId} importId={asImportId(params.importId)} />;
}
