import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import { Clapperboard, RotateCcw, Search } from "lucide-react-native";
import { useState } from "react";

import { Meter, OwnerScreen, QueryView } from "@/components/owner/parts";
import { useTask } from "@/components/owner/use-task";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { asLibraryId, movedOnLine } from "@/lib/owner";
import type { LibraryDetail, Scan } from "@/lib/owner";
import { formatCount } from "@/lib/owner-format";
import { folderTrouble, isActive, isStopped, scanCount, scanLine } from "@/lib/scans";
import { useFinishSetup } from "@/session/finish-setup";
import { useSessionPhase } from "@/session/session-phase";

const lineFor = (scan: Scan): string => {
  const trouble = folderTrouble(scan);

  if (trouble === "offline") return "The NAS can’t be reached.";

  if (trouble === "notApproved") return "This folder isn’t available to the server.";

  return scanLine(scan);
};

const meterLabel = (scan: Scan): string => {
  const count = scanCount(scan);

  if (count !== null) return count.label;

  if (scan.status === "queued") return "Starting";

  return scan.done === null ? "Scanning" : `${formatCount(scan.done)} Files`;
};

function ScanView({ library, scan }: { readonly library: LibraryDetail; readonly scan: Scan }) {
  const platform = usePlatform();
  const phase = useSessionPhase();
  const finishSetup = useFinishSetup();
  const { libraryId } = library;
  const summary = usePlatformQuery(platform.movies.files.summary, { libraryId });
  const [movedOn, setMovedOn] = useState<string | null>(null);
  const active = isActive(scan);
  const count = scanCount(scan);

  const leave = () => {
    if (phase.kind === "setup") {
      void finishSetup();

      return;
    }

    if (router.canGoBack()) router.back();
    else router.replace({ pathname: "/owner/libraries/[libraryId]", params: { libraryId } });
  };

  // The cancel names the attempt shown, so it never stops a later one the person has not seen.
  const stop = useTask(async () => {
    setMovedOn(
      movedOnLine(
        await platform.core.libraries.cancelScan({ jobId: scan.jobId, attempt: scan.attempt }),
      ),
    );
  });

  const retry = useTask(async () => {
    setMovedOn(null);
    await platform.core.libraries.scan({ libraryId, mode: "full" });
  });

  const unmatched = summary.status === "success" ? summary.data.unmatched : null;
  const error = stop.error ?? retry.error;

  return (
    <>
      <Meter
        label={meterLabel(scan)}
        value={count?.fraction ?? 0}
        accessibilityLabel={`${library.name}: ${meterLabel(scan)}`}
      />
      <Text tone="muted" accessibilityLiveRegion="polite">
        {lineFor(scan)}
      </Text>
      {library.items === null ? null : (
        <ListRow icon={Clapperboard} title="Titles" detail={formatCount(library.items)} />
      )}
      {unmatched === null ? null : (
        <ListRow
          icon={Search}
          title="Needs Review"
          detail={formatCount(unmatched)}
          onPress={
            unmatched === 0
              ? undefined
              : () =>
                  router.push({
                    pathname: "/owner/libraries/[libraryId]/files",
                    params: { libraryId, filter: "unmatched" },
                  })
          }
        />
      )}
      {movedOn === null ? null : (
        <Text variant="meta" tone="muted">
          {movedOn}
        </Text>
      )}
      {error === null ? null : (
        <Text variant="meta" tone="danger">
          {error}
        </Text>
      )}
      {isStopped(scan) ? (
        <>
          <Button
            label="Retry Scan"
            icon={RotateCcw}
            busy={retry.busy}
            onPress={() => void retry.run()}
          />
          {folderTrouble(scan) === null ? null : (
            <Button
              label="Edit Folder"
              variant="secondary"
              onPress={() =>
                router.push({
                  pathname: "/owner/libraries/[libraryId]/edit",
                  params: { libraryId },
                })
              }
            />
          )}
          <Button label="Keep Browsing" variant="plain" onPress={leave} />
        </>
      ) : active ? (
        <>
          <Button label="Keep Browsing" variant="secondary" onPress={leave} />
          <Button
            label="Cancel Scan"
            variant="destructive"
            busy={stop.busy}
            disabled={scan.canceling}
            onPress={() => void stop.run()}
          />
        </>
      ) : (
        <Button label="Done" onPress={leave} />
      )}
    </>
  );
}

export default function ScanLibrary() {
  const platform = usePlatform();
  const params = useLocalSearchParams<{ libraryId: string }>();
  const libraryId = asLibraryId(params.libraryId);
  const library = usePlatformQuery(platform.core.libraries.get, { libraryId });
  const name = library.status === "success" ? library.data.name : "Library";
  const scan = library.status === "success" ? library.data.scan : null;
  const title = isActive(scan) ? `Scanning ${name}` : name;

  return (
    <OwnerScreen title={title} fallback="/owner/libraries">
      <QueryView query={library}>
        {(detail) =>
          detail.scan === null ? (
            <Text tone="muted" className="pt-8">
              No scan to show yet.
            </Text>
          ) : (
            <ScanView library={detail} scan={detail.scan} />
          )
        }
      </QueryView>
    </OwnerScreen>
  );
}
