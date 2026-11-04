import type { BackupArchive } from "@media/contracts/models/jobs";
import { Bytes, EpochMillis } from "@media/contracts/units";
import { Duration, Option } from "effect";

/** Why a backup ran. */
export type BackupTrigger = BackupArchive["trigger"];

const NAME = /^movies-(nightly|manual)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.zip$/u;

const ARCHIVE = /^[^./\\][^/\\]*\.zip$/u;

/** The file name of an archive taken at `takenAt` (milliseconds since the epoch). */
export const archiveName = (trigger: BackupTrigger, takenAt: number): string =>
  `movies-${trigger}-${new Date(takenAt).toISOString().replaceAll(/[:.]/gu, "-")}.zip`;

/** The name a partial export is written under before it is renamed to `fileName`. */
export const partialName = (fileName: string): string => `.partial-${fileName}`;

/** Whether `fileName` is a partial export a crashed backup left behind. */
export const isPartial = (fileName: string): boolean =>
  fileName.startsWith(".partial-") && fileName.endsWith(".zip");

/** Whether `fileName` names an archive: a visible `.zip` file directly in the backup folder. */
export const isArchiveName = (fileName: string): boolean => ARCHIVE.test(fileName);

/** The trigger and time encoded in an archive name this service wrote. */
export const parseArchiveName = (
  fileName: string,
): Option.Option<{ readonly trigger: BackupTrigger; readonly takenAt: number }> => {
  const match = NAME.exec(fileName);

  if (match === null) return Option.none();
  const [, trigger, day, hours, minutes, seconds, millis] = match;
  const takenAt = Date.parse(`${day}T${hours}:${minutes}:${seconds}.${millis}Z`);

  return (trigger === "nightly" || trigger === "manual") && Number.isFinite(takenAt)
    ? Option.some({ trigger, takenAt })
    : Option.none();
};

/** An archive found on disk, described from its name, falling back to its size and mtime. */
export const describeArchive = (
  fileName: string,
  sizeBytes: number,
  modifiedAt: number,
): BackupArchive => {
  const parsed = parseArchiveName(fileName);

  return {
    fileName,
    sizeBytes: Bytes.make(sizeBytes),
    trigger: Option.match(parsed, { onNone: () => "manual", onSome: ({ trigger }) => trigger }),
    takenAt: EpochMillis.make(
      Math.floor(
        Option.match(parsed, { onNone: () => modifiedAt, onSome: ({ takenAt }) => takenAt }),
      ),
    ),
  };
};

/**
 * The archives retention removes at `now`: those taken longer than `retention` ago, except
 * `keep` (the backup that just succeeded), so a run never prunes the only fresh archive.
 */
export const expiredArchives = (
  archives: ReadonlyArray<BackupArchive>,
  now: number,
  retention: Duration.Duration,
  keep: string,
): ReadonlyArray<BackupArchive> =>
  archives.filter(
    (archive) => archive.fileName !== keep && archive.takenAt < now - Duration.toMillis(retention),
  );
