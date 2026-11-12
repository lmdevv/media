import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import {
  Clapperboard,
  Ellipsis,
  FileWarning,
  Folder,
  FolderX,
  History,
  RotateCcw,
  Search,
  Wifi,
} from "lucide-react-native";

import {
  InlineState,
  OwnerScreen,
  QueryView,
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
import { asLibraryId } from "@/lib/owner";
import type { LibraryDetail, LibraryFileSummary } from "@/lib/owner";
import { countOf, formatCount, formatWhen } from "@/lib/owner-format";
import { folderTrouble, isActive, scanStateLabel } from "@/lib/scans";

const folderDetail = (folders: ReadonlyArray<string>): string =>
  folders.length === 1
    ? shortFolder(folders[0] ?? "")
    : countOf(folders.length, "Folder", "Folders");

const openScan = (library: LibraryDetail) =>
  router.push({
    pathname: "/owner/libraries/[libraryId]/scan",
    params: { libraryId: library.libraryId },
  });

const edit = (library: LibraryDetail) =>
  router.push({
    pathname: "/owner/libraries/[libraryId]/edit",
    params: { libraryId: library.libraryId },
  });

function FolderRow({ library }: { readonly library: LibraryDetail }) {
  return library.folders === null ? null : (
    <ListRow
      icon={Folder}
      title="Server Folder"
      detail={folderDetail(library.folders)}
      onPress={() => edit(library)}
    />
  );
}

function FolderTrouble({
  library,
  trouble,
}: {
  readonly library: LibraryDetail;
  readonly trouble: "offline" | "notApproved";
}) {
  const platform = usePlatform();

  const retry = useTask(async () => {
    await platform.core.libraries.scan({ libraryId: library.libraryId, mode: "full" });
    openScan(library);
  });

  return (
    <>
      <FolderRow library={library} />
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
  summary,
}: {
  readonly library: LibraryDetail;
  readonly summary: LibraryFileSummary | null;
}) {
  const now = useNow(60_000);
  const platform = usePlatform();
  const { scan } = library;
  const scanning = isActive(scan);

  const start = useTask(async () => {
    await platform.core.libraries.scan({ libraryId: library.libraryId, mode: "full" });
    openScan(library);
  });

  const files = (filter: "unmatched" | "missing") =>
    router.push({
      pathname: "/owner/libraries/[libraryId]/files",
      params: { libraryId: library.libraryId, filter },
    });

  const unmatched = summary?.unmatched ?? null;
  const missing = summary?.missing ?? null;

  return (
    <>
      <FolderRow library={library} />
      {library.items === null ? null : (
        <ListRow icon={Clapperboard} title="Titles" detail={formatCount(library.items)} />
      )}
      <ListRow
        icon={History}
        title="Last Scan"
        detail={
          scan === null
            ? "Never"
            : scan.finishedAt === null
              ? scanStateLabel(scan)
              : `${formatWhen(scan.finishedAt, now)} · ${scanStateLabel(scan)}`
        }
        onPress={scan === null ? undefined : () => openScan(library)}
      />
      <Spacer />
      {start.error === null ? null : (
        <Text variant="meta" tone="danger">
          {start.error}
        </Text>
      )}
      {scanning ? (
        <Button label="Scanning…" onPress={() => openScan(library)} />
      ) : (
        <Button
          label="Scan Library"
          icon={RotateCcw}
          busy={start.busy}
          onPress={() => void start.run()}
        />
      )}
      {unmatched === null ? null : (
        <ListRow
          icon={Search}
          title="Unmatched Files"
          detail={formatCount(unmatched)}
          onPress={unmatched === 0 ? undefined : () => files("unmatched")}
        />
      )}
      {missing === null || missing === 0 ? null : (
        <ListRow
          icon={FileWarning}
          title="Missing Files"
          detail={formatCount(missing)}
          onPress={() => files("missing")}
        />
      )}
    </>
  );
}

export default function Library() {
  const platform = usePlatform();
  const params = useLocalSearchParams<{ libraryId: string }>();
  const libraryId = asLibraryId(params.libraryId);
  const library = usePlatformQuery(platform.core.libraries.get, { libraryId });
  const summary = usePlatformQuery(platform.movies.files.summary, { libraryId });
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

  return (
    <OwnerScreen
      title={name}
      fallback="/owner/libraries"
      trailing={<IconButton icon={Ellipsis} label={`More for ${name}`} onPress={more} />}
    >
      <QueryView query={library}>
        {(detail) => {
          const trouble = folderTrouble(detail.scan);

          return trouble === null ? (
            <LibraryRows
              library={detail}
              summary={summary.status === "success" ? summary.data : null}
            />
          ) : (
            <FolderTrouble library={detail} trouble={trouble} />
          );
        }}
      </QueryView>
    </OwnerScreen>
  );
}
