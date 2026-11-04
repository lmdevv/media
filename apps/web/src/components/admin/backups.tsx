import type { Backup } from "@media/contracts/models/jobs";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { Skeleton } from "@media/ui/components/skeleton";
import { cn } from "@media/ui/lib/utils";
import { UploadIcon } from "lucide-react";
import { useState } from "react";

import { useNow } from "@/lib/use-now";
import { useSignOut } from "@/session/viewer";

import { useAction } from "./action";
import { formatBytes, formatDate, formatDateTime } from "./format";
import { PageHeader } from "./page-header";
import { QueryView } from "./query-view";
import { isActive } from "./scan-jobs";
import { Cell, Column, StatusDot, Table, TableHead } from "./table";

const DAY_MS = 24 * 60 * 60 * 1000;

const takenLabel = (backup: Backup, now: number): string => {
  const at = formatDateTime(backup.createdAt, now);
  const days = Math.floor((startOfDay(now) - startOfDay(backup.createdAt)) / DAY_MS);

  if (days === 0) return `${at} · today`;

  return days === 1 ? `${at} · yesterday` : at;
};

const startOfDay = (ms: number): number => {
  const date = new Date(ms);

  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** Backups: back up now, the nightly schedule, every archive, and restore with confirmation. */
export function BackupsScreen() {
  const backups = useCommandQuery("backups.list", {});
  const jobs = useCommandQuery("jobs.list", { kind: "backup", limit: 5 });
  const run = useCommand("backups.run");
  const [selected, setSelected] = useState<Backup | null>(null);
  const now = useNow(30_000);
  const running = jobs.status === "success" && jobs.data.some((job) => isActive(job));
  const list = backups.status === "success" ? backups.data : [];
  const oldest = list.at(-1);
  const backUp = useAction(() => run({}), { success: () => "Backing up now" });

  return (
    <>
      <PageHeader
        title="Backups"
        actions={
          <Button
            size="xs"
            className="font-semibold"
            disabled={backUp.pending || running}
            onClick={() => void backUp.run()}
          >
            <UploadIcon strokeWidth={2} aria-hidden />
            {running ? "Backing up…" : "Back up now"}
          </Button>
        }
      />
      <div className="flex h-11 items-center justify-between">
        <span className="font-sans text-label/label font-medium text-text">Schedule</span>
        <span className="font-mono text-caption/caption text-text">Nightly · 03:00 UTC</span>
      </div>
      <section aria-labelledby="backup-list" className="flex flex-col gap-0.5 pt-4">
        <div className="flex items-baseline justify-between pb-2">
          <h2 id="backup-list" className="font-sans text-body/body font-semibold text-text">
            Backups
          </h2>
          {oldest === undefined ? null : (
            <span className="font-mono text-caption/caption text-text-muted">
              {list.length} kept · oldest {formatDate(oldest.createdAt, now)}
            </span>
          )}
        </div>
        <QueryView query={backups} loading={<Skeleton className="h-36 w-full rounded-control" />}>
          {() =>
            list.length === 0 ? (
              <p className="px-3 font-sans text-body/body text-text-muted">No backups yet.</p>
            ) : (
              <Table label="Backups" className="gap-0.5">
                <TableHead>
                  <Column className="w-60">Taken</Column>
                  <Column className="w-55">Kind</Column>
                  <Column className="w-25">Size</Column>
                  <Column className="min-w-50 flex-1">File</Column>
                  <Column className="w-28" />
                </TableHead>
                {list.map((backup) => {
                  const chosen = selected?.id === backup.id;

                  return (
                    <div
                      key={backup.id}
                      role="row"
                      className={cn(
                        "flex h-11 shrink-0 items-center gap-3 rounded-control px-3",
                        chosen && "bg-surface-raised",
                      )}
                    >
                      <Cell className="flex w-60 items-center gap-2">
                        <StatusDot tone="success" />
                        <span className="font-mono text-caption/caption text-text">
                          {takenLabel(backup, now)}
                        </span>
                      </Cell>
                      <Cell
                        className={cn(
                          "w-55 font-sans text-label/label",
                          backup.trigger === "manual" ? "text-text" : "text-text-muted",
                        )}
                      >
                        {backup.trigger === "manual" ? "Manual" : "Scheduled"}
                      </Cell>
                      <Cell className="w-25 font-mono text-caption/caption text-text">
                        {formatBytes(backup.sizeBytes)}
                      </Cell>
                      <Cell className="min-w-50 flex-1 truncate font-mono text-caption/caption text-text-muted">
                        {backup.fileName}
                      </Cell>
                      <Cell className="flex w-28 justify-end">
                        {chosen ? (
                          <span className="font-sans text-label/label font-medium text-text-muted">
                            Selected
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setSelected(backup)}
                            aria-label={`Restore ${formatDateTime(backup.createdAt, now)}`}
                            className="cursor-pointer font-sans text-label/label font-semibold text-text hover:text-accent"
                          >
                            Restore…
                          </button>
                        )}
                      </Cell>
                    </div>
                  );
                })}
              </Table>
            )
          }
        </QueryView>
      </section>
      {selected === null ? null : (
        <RestoreConfirm backup={selected} now={now} onCancel={() => setSelected(null)} />
      )}
    </>
  );
}

function RestoreConfirm({
  backup,
  now,
  onCancel,
}: {
  readonly backup: Backup;
  readonly now: number;
  readonly onCancel: () => void;
}) {
  const restore = useCommand("backups.restore");
  const signOut = useSignOut();

  const action = useAction(async () => {
    await restore({ backupId: backup.id });
    await signOut();
  });

  return (
    <section
      role="alertdialog"
      aria-labelledby="restore-title"
      aria-describedby="restore-description"
      className="flex w-full max-w-dialog flex-col gap-5 rounded-card bg-surface-raised p-6"
    >
      <div className="flex flex-col gap-1.5">
        <h2
          id="restore-title"
          className="font-sans text-heading/heading font-bold tracking-tight text-text"
        >
          Restore {formatDateTime(backup.createdAt, now)}?
        </h2>
        <p id="restore-description" className="font-sans text-body/body text-text-muted">
          Everything since then is replaced, and everyone is signed out while the server restarts.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="destructive"
          size="sm"
          className="px-4 text-label/label"
          disabled={action.pending}
          onClick={() => void action.run()}
        >
          {action.pending ? "Restoring…" : "Restore and restart"}
        </Button>
        <Button
          variant="subtle"
          size="sm"
          className="bg-transparent px-4 text-label/label"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}
