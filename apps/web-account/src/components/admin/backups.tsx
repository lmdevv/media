import { BackupId } from "@media/contracts/ids";
import { createMediaServer } from "@media/sdk/promise";
import { usePlatform } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { UploadIcon } from "lucide-react";
import { Schema } from "effect";
import { useMemo, useState } from "react";

import { PageHeader } from "@media/ui/components/page-header";
import { useAccountActions } from "@/session/account";

import { useActions } from "./action";
import { useNow } from "@media/ui/lib/use-now";
import { usePages } from "@media/ui/lib/pages";
import type { Paged } from "@media/ui/lib/pages";
import { ItemRow, Muted, Notice, PagedList, Section, formatTime } from "./parts";
import type { Backup } from "./types";

const NOW_EVERY_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

const DATES = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const decodeBackupId = Schema.decodeUnknownSync(BackupId);

/** A byte size in decimal units with one decimal from GB up, such as `182 MB` or `4.1 GB`. */
export const formatBytes = (bytes: number): string => {
  let value = Math.max(0, bytes);
  let unit = 0;

  while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }

  const digits = unit >= 3 && value < 100 ? 1 : 0;

  return `${value.toFixed(digits)} ${SIZE_UNITS[unit] ?? "B"}`;
};

const startOfDay = (ms: number): number => {
  const date = new Date(ms);

  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** When a backup was taken, with `today` or `yesterday` after the time when it applies. */
export const takenLabel = (takenAt: number, now: number): string => {
  const at = formatTime(takenAt);
  const days = Math.round((startOfDay(now) - startOfDay(takenAt)) / DAY_MS);

  if (days === 0) return `${at} · today`;

  return days === 1 ? `${at} · yesterday` : at;
};

type BackupAction = "run" | "restore";

/** Backups: back up now, the nightly schedule, every backup kept, and restoring one. */
export function BackupsScreen({ mediaUrl }: { readonly mediaUrl: string }) {
  const platform = usePlatform();
  const backups = platform.core.server.backups;
  const list = usePages(backups.list, (paginationOpts) => ({ paginationOpts }));
  const actions = useActions<BackupAction>();
  const { signOut } = useAccountActions();
  const [selected, setSelected] = useState<Backup | null>(null);
  const now = useNow(NOW_EVERY_MS);

  const media = useMemo(
    () => createMediaServer({ url: mediaUrl, accessToken: platform.session.accessToken }),
    [mediaUrl, platform],
  );

  const restore = async (backup: Backup): Promise<void> => {
    const done = await actions.run("restore", () =>
      media.run("backups.restore", { backupId: decodeBackupId(backup.id) }),
    );

    if (done !== undefined) await signOut();
  };

  return (
    <BackupsView
      backups={list}
      selected={selected}
      running={actions.running}
      now={now}
      onBackUp={() => void actions.run("run", () => backups.run({}), "Backing up now")}
      onSelect={setSelected}
      onRestore={(backup) => void restore(backup)}
    />
  );
}

/** The backups page: Back up now, the schedule, the list, and the restore confirmation. */
export function BackupsView({
  backups,
  selected,
  running,
  now,
  onBackUp,
  onSelect,
  onRestore,
}: {
  readonly backups: Paged<Backup>;
  /** The backup whose restore is being confirmed. */
  readonly selected: Backup | null;
  readonly running: BackupAction | null;
  readonly now: number;
  readonly onBackUp: () => void;
  readonly onSelect: (backup: Backup | null) => void;
  readonly onRestore: (backup: Backup) => void;
}) {
  const busy = running !== null;

  const oldest =
    backups.status === "ready" && backups.next.kind === "done" ? backups.rows.at(-1) : undefined;

  return (
    <>
      <PageHeader
        title="Backups"
        actions={
          <Button size="xs" className="font-semibold" disabled={busy} onClick={onBackUp}>
            <UploadIcon strokeWidth={2} aria-hidden />
            {running === "run" ? "Backing up…" : "Back up now"}
          </Button>
        }
      />
      <div className="flex h-11 items-center justify-between">
        <span className="font-sans text-label/label font-medium text-text">Schedule</span>
        <span className="font-mono text-caption/caption text-text">Nightly · 03:00 UTC</span>
      </div>
      <Section title="Backups">
        {oldest === undefined || backups.status !== "ready" ? null : (
          <Muted>{`${backups.rows.length} kept · oldest ${DATES.format(oldest.takenAt)}`}</Muted>
        )}
        <PagedList
          label="Backups"
          list={backups}
          empty="No backups yet."
          rowKey={(backup) => backup.id}
        >
          {(backup) => {
            const chosen = selected?.id === backup.id;

            return (
              <ItemRow
                title={takenLabel(backup.takenAt, now)}
                facts={`${backup.trigger === "manual" ? "Manual" : "Scheduled"} · ${formatBytes(backup.sizeBytes)} · ${backup.fileName}`}
                actions={
                  chosen ? null : (
                    <Button
                      variant="raised"
                      size="row"
                      disabled={busy}
                      aria-label={`Restore ${formatTime(backup.takenAt)}`}
                      onClick={() => onSelect(backup)}
                    >
                      Restore…
                    </Button>
                  )
                }
              >
                {chosen ? (
                  <Notice
                    action={
                      <div className="flex gap-2">
                        <Button variant="ghost" size="xs" onClick={() => onSelect(null)}>
                          Cancel
                        </Button>
                        <Button
                          variant="destructive"
                          size="xs"
                          disabled={busy}
                          onClick={() => onRestore(backup)}
                        >
                          {running === "restore" ? "Restoring…" : "Restore and restart"}
                        </Button>
                      </div>
                    }
                  >
                    {`Everything since ${formatTime(backup.takenAt)} is replaced, and everyone signs in again while the server restarts.`}
                  </Notice>
                ) : null}
              </ItemRow>
            );
          }}
        </PagedList>
      </Section>
    </>
  );
}
