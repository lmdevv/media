import type { HouseholdUser } from "@media/mobile-core/accounts";
import { UserId } from "@media/contracts/ids";
import type { MigrationSource } from "@media/contracts/models/jobs";
import type {
  ImportConnection,
  ImportPhase,
  ImportReport,
  ImportUserMapping,
} from "@media/contracts/models/migration";
import { Schema } from "effect";

import type { ImportRun } from "./owner";
import { countOf, formatCount } from "./owner-format";

/** The credential each source takes, as its field is labeled (J01, J06). */
export const CREDENTIAL_LABELS: Readonly<Record<MigrationSource, string>> = {
  jellyfin: "API Key",
  plex: "Plex Token",
};

/** The choice that skips a source user. */
export const SKIP = "skip";

/** Where a source user's history goes: a user here, or {@link SKIP}. */
export type UserChoice = UserId | typeof SKIP;

/** A user a source user's history can go to, as Users lists it. */
interface UserOption {
  readonly value: UserChoice;
  readonly label: string;
}

/** One source user on Users: who it is, where its history goes, and the choices. */
export interface UserRow {
  readonly sourceUserId: string;
  readonly name: string;
  readonly choice: UserChoice;
  readonly options: ReadonlyArray<UserOption>;
}

/** How the choice that skips a source user reads on iOS, in title case like Paper's actions. */
const SKIP_LABEL = "Don’t Import";

const toUserId = Schema.decodeUnknownSync(UserId);

/**
 * Users' rows. Each row offers every person here, the user connect suggested when the list does
 * not hold it yet, and skipping. The current choice is the dry run's.
 */
export const userRows = (
  connection: ImportConnection,
  report: ImportReport,
  people: ReadonlyArray<HouseholdUser>,
): ReadonlyArray<UserRow> => {
  const listed = people.map((person): UserOption => ({
    value: toUserId(person.userId),
    label: person.username,
  }));

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
      options: [...suggested, ...listed, { value: SKIP, label: SKIP_LABEL }],
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

/** The label of a row's current choice. */
export const choiceLabel = (row: UserRow): string =>
  row.options.find((option) => option.value === row.choice)?.label ?? SKIP_LABEL;

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

/** A row of the Review or Import Complete list: what, how many, and the detail shown. */
export interface CountRow {
  readonly key: "libraries" | "users" | "watched" | "inProgress" | "favorites" | "collections";
  readonly title: string;
  readonly detail: string;
}

const items = (count: number): string => countOf(count, "Item", "Items");

/**
 * J02 Review: the libraries the import uses or adds, the users whose history comes along, and
 * what it brings. Collections show only when there are any.
 */
export const reviewRows = (report: ImportReport): ReadonlyArray<CountRow> => {
  const { summary } = report;
  const importing = report.users.filter((user) => user.action === "import").length;
  const added = report.libraries.filter((library) => library.existingLibraryId === null).length;

  const rows: ReadonlyArray<CountRow> = [
    {
      key: "libraries",
      title: "Libraries",
      detail: added === 0 ? formatCount(report.libraries.length) : `${formatCount(added)} New`,
    },
    { key: "users", title: "Users", detail: `${formatCount(importing)} of ${report.users.length}` },
    { key: "watched", title: "Watch History", detail: items(summary.watched) },
    { key: "inProgress", title: "In Progress", detail: items(summary.inProgress) },
    { key: "favorites", title: "Favorites", detail: formatCount(summary.favorites) },
    { key: "collections", title: "Collections", detail: formatCount(summary.collections) },
  ];

  return rows.filter((row) => row.key !== "collections" || summary.collections > 0);
};

/** J04 Import Complete: what the import wrote. */
export const doneRows = (run: ImportRun): ReadonlyArray<CountRow> => {
  const { imported } = run;

  const rows: ReadonlyArray<CountRow> = [
    { key: "libraries", title: "Libraries Added", detail: formatCount(imported.librariesAdded) },
    { key: "watched", title: "Watch History", detail: items(imported.watched) },
    { key: "inProgress", title: "In Progress", detail: items(imported.inProgress) },
    { key: "favorites", title: "Favorites", detail: formatCount(imported.favorites) },
    { key: "collections", title: "Collections", detail: formatCount(imported.collections) },
  ];

  return rows.filter((row) => row.key !== "collections" || imported.collections > 0);
};

const PHASES: ReadonlyArray<{ readonly phase: ImportPhase; readonly title: string }> = [
  { phase: "libraries", title: "Libraries" },
  { phase: "scanning", title: "New Folders" },
  { phase: "watchState", title: "Watch History" },
  { phase: "collections", title: "Collections" },
  { phase: "overrides", title: "Title Edits" },
];

/** One phase on J03 Importing: done, under way with its count, or still to come. */
export interface PhaseRow {
  readonly phase: ImportPhase;
  readonly title: string;
  readonly state: "done" | "running" | "waiting";
  readonly detail: string;
}

/** J03's phase rows for `run`. */
export const phaseRows = (run: ImportRun): ReadonlyArray<PhaseRow> => {
  const finished = run.job.status === "succeeded" || run.phase === "done";
  const current = PHASES.findIndex((each) => each.phase === run.phase);
  const { done, total } = run.job;

  return PHASES.map(({ phase, title }, index): PhaseRow => {
    if (finished || index < current) return { phase, title, state: "done", detail: "Complete" };

    if (index > current) return { phase, title, state: "waiting", detail: "Waiting" };

    const detail =
      run.job.status === "queued"
        ? "Waiting"
        : total === null
          ? "Working"
          : `${formatCount(done)} of ${formatCount(total)}`;

    return { phase, title, state: "running", detail };
  });
};
