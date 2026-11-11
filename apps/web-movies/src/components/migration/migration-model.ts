import { UserId } from "@media/contracts/ids";
import type { MigrationSource } from "@media/contracts/models/jobs";
import type {
  ImportConnection,
  ImportPhase,
  ImportReport,
  ImportUserMapping,
} from "@media/contracts/models/migration";
import { Schema } from "effect";

import type { ImportRun, Person } from "@/components/admin/types";

/** What the Importing screen says each phase is doing. */
export const PHASE_LABELS: Readonly<Record<ImportPhase, string>> = {
  libraries: "Adding libraries",
  scanning: "Scanning new folders",
  watchState: "Watched status",
  collections: "Collections",
  overrides: "Title and artwork edits",
  done: "Finishing",
};

/**
 * What the admin typed on Connect. It stays in the page's memory only, so Review can reconnect
 * with new folder mappings and Back returns to a filled form.
 */
export interface SourceForm {
  readonly source: MigrationSource;
  readonly url: string;
  /** A Jellyfin API key or a Plex token. Never stored, logged, or put in the URL. */
  readonly token: string;
}

/** An empty Connect form for Jellyfin. */
export const EMPTY_FORM: SourceForm = { source: "jellyfin", url: "", token: "" };

/** The choice that skips a source user. */
export const SKIP = "skip";

/** Where a source user's history goes: a user here, or {@link SKIP}. */
export type UserChoice = UserId | typeof SKIP;

/** A user a source user's history can go to, as the Review screen lists it. */
interface UserOption {
  readonly value: UserChoice;
  readonly label: string;
}

/** One source user on the Review screen: who it is, where its history goes, and the choices. */
export interface UserRow {
  readonly sourceUserId: string;
  readonly name: string;
  readonly choice: UserChoice;
  readonly options: ReadonlyArray<UserOption>;
}

const toUserId = Schema.decodeUnknownSync(UserId);

/**
 * The Review screen's user rows. Each row offers every user here but guests, the user connect
 * suggested when the list does not hold it yet, and skipping, labeled `skipLabel`. The current
 * choice is the dry run's.
 */
export const userRows = (
  connection: ImportConnection,
  report: ImportReport,
  people: ReadonlyArray<Person>,
  skipLabel: string,
): ReadonlyArray<UserRow> => {
  const listed = people.flatMap((person): ReadonlyArray<UserOption> =>
    person.role === "guest" ? [] : [{ value: toUserId(person.userId), label: person.username }],
  );

  return connection.users.map((user): UserRow => {
    const planned = report.users.find((each) => each.sourceUserId === user.sourceUserId);
    const { suggestion } = user;

    const suggested: ReadonlyArray<UserOption> =
      suggestion.kind === "user" && !listed.some((option) => option.value === suggestion.userId)
        ? [{ value: suggestion.userId, label: "Suggested" }]
        : [];

    return {
      sourceUserId: user.sourceUserId,
      name: user.name,
      choice: planned?.userId ?? SKIP,
      options: [...suggested, ...listed, { value: SKIP, label: skipLabel }],
    };
  });
};

/** The dry run's mappings as they stand, with `sourceUserId` changed to `choice` when given. */
export const mappingsFor = (
  rows: ReadonlyArray<UserRow>,
  change?: { readonly sourceUserId: string; readonly choice: UserChoice },
): ReadonlyArray<ImportUserMapping> =>
  rows.map((row) => {
    const next = row.sourceUserId === change?.sourceUserId ? change.choice : row.choice;

    return { sourceUserId: row.sourceUserId, userId: next === SKIP ? null : next };
  });

/** Whether an import is still queued or running. */
export const isRunning = (run: ImportRun): boolean =>
  run.job.status === "queued" || run.job.status === "running";

const PHASE_WEIGHTS: ReadonlyArray<readonly [ImportPhase, number]> = [
  ["libraries", 0.05],
  ["scanning", 0.25],
  ["watchState", 0.55],
  ["collections", 0.05],
  ["overrides", 0.1],
];

/**
 * How far an import has come, from 0 to 1, across all its phases. A finished import is complete;
 * a phase without a known total counts as just started.
 */
export const importFraction = (run: ImportRun): number => {
  if (run.job.status === "succeeded" || run.phase === "done") return 1;

  const index = PHASE_WEIGHTS.findIndex(([phase]) => phase === run.phase);
  const before = PHASE_WEIGHTS.slice(0, index).reduce((sum, [, weight]) => sum + weight, 0);
  const weight = PHASE_WEIGHTS[index]?.[1] ?? 0;
  const { done, total } = run.job;
  const within = total === null || total <= 0 ? 0 : Math.min(1, Math.max(0, done / total));

  return Math.min(1, before + weight * within);
};

/**
 * Whole minutes left at the pace since the job started running, at least 1, not since the import
 * was made, which includes its wait in the queue. Null until there is a pace (2% done), while it
 * waits for the media service, and once it is complete.
 */
export const importMinutesLeft = (run: ImportRun, fraction: number, now: number): number | null => {
  if (run.job.startedAt === null || fraction < 0.02 || fraction >= 1) return null;

  const elapsed = Math.max(0, now - run.job.startedAt);

  return Math.max(1, Math.round((elapsed / fraction - elapsed) / 60_000));
};
