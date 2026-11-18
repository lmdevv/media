import { usePages } from "@media/mobile-core/pages";
import { usePlatform } from "@media/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import { FileQuestion, FileWarning } from "lucide-react-native";

import { OwnerScreen, PagedView, useNow } from "@/components/owner/parts";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { facts } from "@/lib/format";
import { asLibraryId } from "@/lib/owner";
import type { LibraryFile } from "@/lib/owner";
import { formatWhen } from "@/lib/owner-format";

type Filter = "unmatched" | "missing";

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const guess = (file: LibraryFile): string =>
  file.episode === null
    ? facts(file.title.name, file.title.year)
    : `${file.title.name} · S${file.episode.seasonNumber} E${file.episode.episodeNumber}`;

export default function LibraryFiles() {
  const platform = usePlatform();
  const params = useLocalSearchParams<{ libraryId: string; filter?: string }>();
  const libraryId = asLibraryId(params.libraryId);
  const filter: Filter = params.filter === "missing" ? "missing" : "unmatched";
  const now = useNow(60_000);

  // A page the core cannot read in one call comes back to be split; `usePages` loads it as two.
  const files = usePages(platform.movies.files.list, (paginationOpts) => ({
    libraryId,
    filter,
    paginationOpts,
  }));

  return (
    <OwnerScreen title={filter === "missing" ? "Missing Files" : "Unmatched Files"}>
      <PagedView list={files}>
        {(rows, done) =>
          rows.length === 0 && done ? (
            <Text tone="muted">
              {filter === "missing" ? "No missing files." : "Every title is matched."}
            </Text>
          ) : (
            rows.map((file) => (
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
                          params: { libraryId, titleId: file.title.id, file: fileName(file.path) },
                        })
                }
              />
            ))
          )
        }
      </PagedView>
    </OwnerScreen>
  );
}
