import { router } from "expo-router";
import {
  Bookmark,
  Folder,
  History,
  Library as LibraryIcon,
  Play,
  Users,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";

import { useImportState, useReview } from "@/components/owner/import-state";
import type { Preview } from "@/components/owner/import-state";
import { OwnerScreen } from "@/components/owner/parts";
import { useTask } from "@/components/owner/use-task";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { mappingsFor, reviewRows } from "@/lib/migration";
import type { CountRow } from "@/lib/migration";
import { countOf } from "@/lib/owner-format";
import { useMediaServer } from "@/session/media-server";

const ICONS: Readonly<Record<CountRow["key"], LucideIcon>> = {
  libraries: Folder,
  users: Users,
  watched: History,
  inProgress: Play,
  favorites: Bookmark,
  collections: LibraryIcon,
};

const OPENS: Partial<Record<CountRow["key"], "/owner/import/libraries" | "/owner/import/users">> = {
  libraries: "/owner/import/libraries",
  users: "/owner/import/users",
};

const cautions = (preview: Preview): ReadonlyArray<string> => {
  const { summary, users } = preview.report;
  const skipped = users.filter((user) => user.action !== "import");

  return [
    summary.itemsUnmatched === 0
      ? null
      : `${countOf(summary.itemsUnmatched, "title", "titles")} couldn’t be matched and will be skipped.`,
    skipped.length === 0
      ? null
      : `${skipped.map((user) => user.name).join(", ")} won’t be imported.`,
    summary.conflicts === 0
      ? null
      : `${countOf(summary.conflicts, "title keeps", "titles keep")} newer progress already here.`,
  ].flatMap((line) => (line === null ? [] : [line]));
};

function ReviewList({ preview }: { readonly preview: Preview }) {
  const media = useMediaServer();
  const { rows } = useReview(preview);

  const begin = useTask(async () => {
    const result = await media.run("imports.start", {
      connectionId: preview.connection.connectionId,
      users: mappingsFor(rows),
    });

    if (result.status === "failed") throw new Error(result.message);

    router.replace({ pathname: "/owner/import/progress", params: { importId: result.importId } });
  });

  return (
    <>
      {reviewRows(preview.report).map((row) => {
        const opens = OPENS[row.key];

        return (
          <ListRow
            key={row.key}
            icon={ICONS[row.key]}
            title={row.title}
            detail={row.detail}
            onPress={opens === undefined ? undefined : () => router.push(opens)}
          />
        );
      })}
      {cautions(preview).map((line) => (
        <Text key={line} variant="secondary" tone="muted">
          {line}
        </Text>
      ))}
      <Text tone="muted">Media stays in your existing folders.</Text>
      {begin.error === null ? null : (
        <Text variant="meta" tone="danger">
          {begin.error}
        </Text>
      )}
      <Button label="Start Import" busy={begin.busy} onPress={() => void begin.run()} />
    </>
  );
}

export default function ReviewImport() {
  const { preview } = useImportState();

  return (
    <OwnerScreen title="Review Import" fallback="/owner/import">
      {preview === null ? (
        <Text tone="muted">Connect to a server first.</Text>
      ) : (
        <ReviewList preview={preview} />
      )}
    </OwnerScreen>
  );
}
