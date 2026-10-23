/**
 * Remove download?: asked from a finished download's ring (Paper's D04, "same sheet as C12"). Its
 * files leave this iPhone at once; the server's library is untouched.
 */
import { DownloadTarget } from "@music/commands/models";
import { targetKey } from "@music/sdk/downloads";
import { Option, Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { useDownload, useDownloadsLibrary } from "@/downloads";
import { removeDownloadCopy } from "@/lib/download-control";

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

  // Worded once: the sheet must not change its words while it closes over the removal.
  const [copy] = useState(() =>
    removeDownloadCopy(item?.title ?? title ?? "This download", item?.bytes ?? 0),
  );

  return (
    <ConfirmSheet
      title="Remove download?"
      body={copy.body}
      confirmLabel={copy.confirmLabel}
      pendingLabel="Removing…"
      cancelLabel="Keep download"
      onConfirm={async () => {
        // Toggling a download that is already gone would start it again.
        if (download.status.kind !== "none") await download.toggle();
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
