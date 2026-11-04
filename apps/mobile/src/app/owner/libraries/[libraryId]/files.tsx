import { LibraryId } from "@media/contracts/ids";
import type { LibraryFile } from "@media/contracts/models/catalog";
import { useCommandQuery } from "@media/sdk/react";
import { Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { FileQuestion, FileWarning } from "lucide-react-native";
import { useState } from "react";

import { Loading, LoadFailure, OwnerScreen, useNow } from "@/components/owner/parts";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { facts } from "@/lib/format";
import { formatWhen } from "@/lib/owner-format";

const decodeLibraryId = Schema.decodeUnknownSync(LibraryId);

const PAGE_SIZE = 50;

type Filter = "unmatched" | "missing";

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const guess = (file: LibraryFile): string =>
  file.episode === null
    ? facts(file.title.name, file.title.year)
    : `${file.title.name} · S${file.episode.seasonNumber} E${file.episode.episodeNumber}`;

function FilePage({
  libraryId,
  filter,
  cursor,
  last,
  onMore,
}: {
  readonly libraryId: LibraryId;
  readonly filter: Filter;
  readonly cursor: string | null;
  readonly last: boolean;
  readonly onMore: (cursor: string) => void;
}) {
  const now = useNow(60_000);
  const page = useCommandQuery("libraries.files", { libraryId, filter, cursor, limit: PAGE_SIZE });

  if (page.status === "loading") return <Loading />;

  if (page.status === "error") return <LoadFailure error={page.error} retry={page.retry} />;

  const next = page.data.nextCursor;

  return (
    <>
      {cursor === null && page.data.items.length === 0 ? (
        <Text tone="muted">
          {filter === "missing" ? "No missing files." : "Every title is matched."}
        </Text>
      ) : null}
      {page.data.items.map((file) => (
        <ListRow
          key={file.id}
          icon={file.missing ? FileWarning : FileQuestion}
          title={fileName(file.path)}
          subtitle={
            file.missing && file.missingSince !== null
              ? `Missing since ${formatWhen(file.missingSince, now)}`
              : guess(file)
          }
          onPress={
            file.missing
              ? undefined
              : () =>
                  router.push({
                    pathname: "/owner/libraries/[libraryId]/match/[titleId]",
                    params: { libraryId, titleId: file.title.id },
                  })
          }
        />
      ))}
      {last && next !== null ? (
        <Button label="Show More" variant="secondary" onPress={() => onMore(next)} />
      ) : null}
    </>
  );
}

export default function LibraryFiles() {
  const params = useLocalSearchParams<{ libraryId: string; filter?: string }>();
  const libraryId = decodeLibraryId(params.libraryId);
  const filter: Filter = params.filter === "missing" ? "missing" : "unmatched";
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);

  return (
    <OwnerScreen title={filter === "missing" ? "Missing Files" : "Unmatched Files"}>
      {[null, ...cursors].map((cursor) => (
        <FilePage
          key={cursor ?? "first"}
          libraryId={libraryId}
          filter={filter}
          cursor={cursor}
          last={cursor === (cursors[cursors.length - 1] ?? null)}
          onMore={(next) =>
            setCursors((current) => (current.includes(next) ? current : [...current, next]))
          }
        />
      ))}
    </OwnerScreen>
  );
}
