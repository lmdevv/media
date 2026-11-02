import { DownloadTarget } from "@music/commands/models";
import { targetKey } from "@music/sdk/downloads";
import { Option, Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { useDownload, useDownloadsLibrary } from "@/downloads";
import { removeDownloadCopy } from "@/lib/download-control";
import type { RemoveCopy } from "@/lib/download-control";
import { DEVICE_FAMILY } from "@/lib/this-device";

const decodeTarget = Schema.decodeUnknownOption(DownloadTarget);

function Confirm({
  target,
  title,
}: {
  readonly target: DownloadTarget;
  readonly title: string | undefined;
}) {
  const download = useDownload(target);
  const key = targetKey(target);
  const item = useDownloadsLibrary().downloads.find((held) => targetKey(held.target) === key);

  const live = removeDownloadCopy(
    item?.title ?? title ?? "This download",
    target.kind,
    item ?? { bytes: 0, freedBytes: 0 },
    DEVICE_FAMILY,
  );

  const [frozen, setFrozen] = useState<RemoveCopy | null>(null);
  const copy = frozen ?? live;

  return (
    <ConfirmSheet
      title="Remove download?"
      body={copy.body}
      confirmLabel={copy.confirmLabel}
      pendingLabel="Removing…"
      cancelLabel="Keep download"
      onConfirm={async () => {
        setFrozen(live);

        try {
          if (download.status.kind !== "none") await download.toggle();
        } catch (cause) {
          setFrozen(null);
          throw cause;
        }

        router.back();
      }}
    />
  );
}

export default function RemoveDownload() {
  const { kind, id, title } = useLocalSearchParams<{
    kind: string;
    id: string;
    title?: string;
  }>();

  const target = Option.getOrNull(decodeTarget({ kind, id }));

  if (target === null) {
    return (
      <SheetLayout
        title="Remove download?"
        subtitle="This download couldn’t be opened. Close and try again."
      />
    );
  }

  return <Confirm target={target} title={title} />;
}
