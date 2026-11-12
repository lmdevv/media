import { usePages } from "@media/mobile-core/pages";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { router } from "expo-router";
import { Server } from "lucide-react-native";

import { OwnerScreen, PagedView, SectionHeading, useNow } from "@/components/owner/parts";
import { useTask } from "@/components/owner/use-task";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { formatBytes, formatWhen } from "@/lib/owner-format";

export default function Backups() {
  const platform = usePlatform();
  const now = useNow(60_000);
  const { backups } = platform.core.server;
  const list = usePages(backups.list, (paginationOpts) => ({ paginationOpts }));
  const active = usePlatformQuery(backups.active);
  const backUp = useTask(() => backups.run({}));
  const running = active.status === "success" && active.data !== null;

  return (
    <OwnerScreen title="Backups">
      {backUp.error === null ? null : (
        <Text variant="meta" tone="danger">
          {backUp.error}
        </Text>
      )}
      <Button
        label={running ? "Backing Up…" : "Back Up Now"}
        icon={Server}
        busy={backUp.busy}
        disabled={running}
        onPress={() => void backUp.run()}
      />
      <SectionHeading>Latest Backups</SectionHeading>
      <PagedView list={list}>
        {(rows, done) =>
          rows.length === 0 && done ? (
            <Text tone="muted">No backups yet.</Text>
          ) : (
            rows.map((backup) => (
              <ListRow
                key={backup.id}
                icon={Server}
                title={formatWhen(backup.takenAt, now)}
                detail={formatBytes(backup.sizeBytes)}
                onPress={() =>
                  router.push({
                    pathname: "/owner/backups/[backupId]",
                    params: { backupId: backup.id },
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
