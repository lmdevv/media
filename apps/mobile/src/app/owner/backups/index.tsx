import { useCommand, useCommandQuery } from "@media/sdk/react";
import { router } from "expo-router";
import { Server } from "lucide-react-native";

import { OwnerScreen, QueryView, SectionHeading, useNow } from "@/components/owner/parts";
import { useTask } from "@/components/owner/use-task";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { formatBytes, formatWhen } from "@/lib/owner-format";
import { isActive } from "@/lib/scans";

export default function Backups() {
  const now = useNow(60_000);
  const backups = useCommandQuery("backups.list", {});
  const jobs = useCommandQuery("jobs.list", { kind: "backup", limit: 5 });
  const run = useCommand("backups.run");
  const backUp = useTask(() => run({}));
  const running = jobs.status === "success" && jobs.data.some((job) => isActive(job));

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
      <QueryView query={backups}>
        {(list) =>
          list.length === 0 ? (
            <Text tone="muted">No backups yet.</Text>
          ) : (
            list.map((backup) => (
              <ListRow
                key={backup.id}
                icon={Server}
                title={formatWhen(backup.createdAt, now)}
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
      </QueryView>
    </OwnerScreen>
  );
}
