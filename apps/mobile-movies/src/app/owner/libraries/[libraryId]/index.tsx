import { LibraryId } from "@media/contracts/ids";
import type { LibraryDetail, LibraryFileSummary } from "@media/contracts/models/catalog";
import type { Job } from "@media/contracts/models/jobs";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import {
  Check,
  Clapperboard,
  Ellipsis,
  FileWarning,
  Folder,
  FolderX,
  History,
  LoaderCircle,
  RotateCcw,
  Search,
  Wifi,
  X,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";

import {
  InlineState,
  OwnerScreen,
  QueryView,
  SectionHeading,
  Spacer,
  showActions,
  useNow,
} from "@/components/owner/parts";
import { useTask } from "@/components/owner/use-task";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { shortFolder } from "@/lib/library-form";
import { countOf, formatCount, formatWhen } from "@/lib/owner-format";
import { folderTrouble, isActive, scanStateLabel } from "@/lib/scans";

const decodeLibraryId = Schema.decodeUnknownSync(LibraryId);

const RECENT = 3;

const SCAN_ICONS: Readonly<Record<Job["status"], LucideIcon>> = {
  pending: LoaderCircle,
  running: LoaderCircle,
  succeeded: Check,
  failed: X,
  cancelled: X,
};

const folderDetail = (library: LibraryDetail): string =>
  library.roots.length === 1
    ? shortFolder(library.roots[0] ?? "")
    : countOf(library.roots.length, "Folder", "Folders");

const openScan = (library: LibraryDetail, job: Job | undefined) =>
  router.push({
    pathname: "/owner/libraries/[libraryId]/scan",
    params:
      job === undefined ? { libraryId: library.id } : { libraryId: library.id, jobId: job.id },
  });

const edit = (library: LibraryDetail) =>
  router.push({ pathname: "/owner/libraries/[libraryId]/edit", params: { libraryId: library.id } });

function FolderTrouble({
  library,
  trouble,
}: {
  readonly library: LibraryDetail;
  readonly trouble: "offline" | "notApproved";
}) {
  const scan = useCommand("libraries.scan");

  const retry = useTask(async () => {
    const queued = await scan({ libraryId: library.id, mode: "full" });

    router.push({
      pathname: "/owner/libraries/[libraryId]/scan",
      params: { libraryId: library.id, jobId: queued.jobId },
    });
  });

  return (
    <>
      <ListRow
        icon={Folder}
        title="Server Folder"
        detail={folderDetail(library)}
        onPress={() => edit(library)}
      />
      {trouble === "offline" ? (
        <>
          <InlineState
            icon={Wifi}
            title="Folder unavailable"
            description="The NAS can’t be reached."
          />
          {retry.error === null ? null : (
            <Text variant="meta" tone="danger">
              {retry.error}
            </Text>
          )}
          <Button
            label="Retry Scan"
            icon={RotateCcw}
            busy={retry.busy}
            onPress={() => void retry.run()}
          />
          <Button label="Edit Folder" variant="secondary" onPress={() => edit(library)} />
        </>
      ) : (
        <>
          <InlineState
            icon={FolderX}
            title="Folder unavailable"
            description="This folder isn’t available to the server."
          />
          <Button label="Choose Another Folder" icon={Folder} onPress={() => edit(library)} />
        </>
      )}
    </>
  );
}

function LibraryRows({
  library,
  scans,
  summary,
}: {
  readonly library: LibraryDetail;
  readonly scans: ReadonlyArray<Job>;
  readonly summary: LibraryFileSummary | null;
}) {
  const now = useNow(60_000);
  const scan = useCommand("libraries.scan");
  const [latest] = scans;
  const scanning = isActive(latest) || library.scanning;

  const start = useTask(async () => {
    const queued = await scan({ libraryId: library.id, mode: "full" });

    router.push({
      pathname: "/owner/libraries/[libraryId]/scan",
      params: { libraryId: library.id, jobId: queued.jobId },
    });
  });

  const files = (filter: "unmatched" | "missing") =>
    router.push({
      pathname: "/owner/libraries/[libraryId]/files",
      params: { libraryId: library.id, filter },
    });

  return (
    <>
      <ListRow
        icon={Folder}
        title="Server Folder"
        detail={folderDetail(library)}
        onPress={() => edit(library)}
      />
      <ListRow
        icon={Clapperboard}
        title={library.kind === "shows" ? "Shows" : "Titles"}
        detail={formatCount(library.titleCount)}
      />
      <ListRow
        icon={History}
        title="Last Scan"
        detail={library.lastScanAt === null ? "Never" : formatWhen(library.lastScanAt, now)}
        onPress={latest === undefined ? undefined : () => openScan(library, latest)}
      />
      <Spacer />
      {start.error === null ? null : (
        <Text variant="meta" tone="danger">
          {start.error}
        </Text>
      )}
      {scanning ? (
        <Button label="Scanning…" onPress={() => openScan(library, latest)} />
      ) : (
        <Button
          label="Scan Library"
          icon={RotateCcw}
          busy={start.busy}
          onPress={() => void start.run()}
        />
      )}
      {scans.length === 0 ? null : <SectionHeading>Recent Scans</SectionHeading>}
      {scans.slice(0, RECENT).map((job) => (
        <ListRow
          key={job.id}
          icon={SCAN_ICONS[job.status]}
          title={formatWhen(job.createdAt, now)}
          detail={scanStateLabel(job)}
          onPress={() => openScan(library, job)}
        />
      ))}
      {summary === null ? null : (
        <ListRow
          icon={Search}
          title="Unmatched Files"
          detail={formatCount(summary.unmatchedTitles)}
          onPress={summary.unmatchedTitles === 0 ? undefined : () => files("unmatched")}
        />
      )}
      {summary === null || summary.missingFiles === 0 ? null : (
        <ListRow
          icon={FileWarning}
          title="Missing Files"
          detail={formatCount(summary.missingFiles)}
          onPress={() => files("missing")}
        />
      )}
    </>
  );
}

export default function Library() {
  const params = useLocalSearchParams<{ libraryId: string }>();
  const libraryId = decodeLibraryId(params.libraryId);
  const library = useCommandQuery("libraries.get", { libraryId });
  const summary = useCommandQuery("libraries.fileSummary", { libraryId });
  const jobs = useCommandQuery("jobs.list", { kind: "scan", libraryId, limit: RECENT });
  const scans = jobs.status === "success" ? jobs.data : [];
  const name = library.status === "success" ? library.data.name : "Library";

  const more = () => {
    if (library.status !== "success") return;

    showActions(undefined, [
      { label: "Edit Library", onPress: () => edit(library.data) },
      {
        label: "Remove Library",
        destructive: true,
        onPress: () =>
          router.push({
            pathname: "/owner/libraries/[libraryId]/remove",
            params: { libraryId, name: library.data.name },
          }),
      },
    ]);
  };

  const trouble = folderTrouble(scans[0]);

  return (
    <OwnerScreen
      title={name}
      fallback="/owner/libraries"
      trailing={<IconButton icon={Ellipsis} label={`More for ${name}`} onPress={more} />}
    >
      <QueryView query={library}>
        {(detail) =>
          trouble === null ? (
            <LibraryRows
              library={detail}
              scans={scans}
              summary={summary.status === "success" ? summary.data : null}
            />
          ) : (
            <FolderTrouble library={detail} trouble={trouble} />
          )
        }
      </QueryView>
    </OwnerScreen>
  );
}
