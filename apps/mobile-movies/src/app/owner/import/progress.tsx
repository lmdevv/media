import type { MigrationPhase, MigrationRun } from "@media/contracts/models/migration";
import { SOURCE_NAMES, importFraction } from "@media/contracts/migration-plan";
import { useCommandQuery } from "@media/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
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
  X,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";

import { InlineState, Loading, LoadFailure, Meter, OwnerScreen } from "@/components/owner/parts";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { doneRows, phaseRows } from "@/lib/migration";
import type { CountRow } from "@/lib/migration";
import { formatPercent } from "@/lib/owner-format";
import { isActive } from "@/lib/scans";
import { useFinishSetup } from "@/session/finish-setup";
import { useSessionPhase } from "@/session/session-phase";

const PHASE_ICONS: Readonly<Record<MigrationPhase, LucideIcon>> = {
  libraries: Folder,
  scanning: FolderSearch,
  watchState: History,
  collections: LibraryIcon,
  overrides: Pencil,
  done: Check,
};

const DONE_ICONS: Readonly<Record<CountRow["key"], LucideIcon>> = {
  libraries: Folder,
  users: Folder,
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

function Importing({ run }: { readonly run: MigrationRun }) {
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

function Complete({ run }: { readonly run: MigrationRun }) {
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

function Stopped({ run }: { readonly run: MigrationRun }) {
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

export default function ImportProgress() {
  const params = useLocalSearchParams<{ jobId?: string }>();
  const runs = useCommandQuery("migration.status", {});
  const leave = useLeaveImport();

  if (runs.status === "loading") {
    return (
      <OwnerScreen title="Importing" onBack={leave}>
        <Loading />
      </OwnerScreen>
    );
  }

  if (runs.status === "error") {
    return (
      <OwnerScreen title="Importing" onBack={leave}>
        <LoadFailure error={runs.error} retry={runs.retry} />
      </OwnerScreen>
    );
  }

  const run =
    runs.data.find((each) => each.job.id === params.jobId) ??
    runs.data.find((each) => isActive(each.job));

  if (run === undefined) {
    return (
      <OwnerScreen title="Importing" onBack={leave}>
        <Text tone="muted">This import is gone.</Text>
      </OwnerScreen>
    );
  }

  if (run.job.status === "succeeded") {
    return (
      <OwnerScreen title="Import Complete" onBack={leave}>
        <Complete run={run} />
      </OwnerScreen>
    );
  }

  return (
    <OwnerScreen title="Importing" onBack={leave}>
      {isActive(run.job) ? <Importing run={run} /> : <Stopped run={run} />}
    </OwnerScreen>
  );
}
