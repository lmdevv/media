import type { UserRow } from "@media/contracts/migration-plan";
import type { MigrationSource } from "@media/contracts/models/jobs";
import type {
  MigrationPhase,
  MigrationReport,
  MigrationRun,
} from "@media/contracts/models/migration";

import { countOf, formatCount } from "./owner-format";

/** The credential each source takes, as its field is labeled (J01, J06). */
export const CREDENTIAL_LABELS: Readonly<Record<MigrationSource, string>> = {
  jellyfin: "API Key",
  plex: "Plex Token",
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
export const reviewRows = (report: MigrationReport): ReadonlyArray<CountRow> => {
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
export const doneRows = (run: MigrationRun): ReadonlyArray<CountRow> => {
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

const PHASES: ReadonlyArray<{ readonly phase: MigrationPhase; readonly title: string }> = [
  { phase: "libraries", title: "Libraries" },
  { phase: "scanning", title: "New Folders" },
  { phase: "watchState", title: "Watch History" },
  { phase: "collections", title: "Collections" },
  { phase: "overrides", title: "Title Edits" },
];

/** One phase on J03 Importing: done, under way with its count, or still to come. */
export interface PhaseRow {
  readonly phase: MigrationPhase;
  readonly title: string;
  readonly state: "done" | "running" | "waiting";
  readonly detail: string;
}

/** J03's phase rows for `run`. */
export const phaseRows = (run: MigrationRun): ReadonlyArray<PhaseRow> => {
  const finished = run.job.status === "succeeded" || run.phase === "done";
  const current = PHASES.findIndex((each) => each.phase === run.phase);
  const { done, total } = run.job.progress;

  return PHASES.map(({ phase, title }, index): PhaseRow => {
    if (finished || index < current) return { phase, title, state: "done", detail: "Complete" };

    if (index > current) return { phase, title, state: "waiting", detail: "Waiting" };

    const detail =
      run.job.status === "pending"
        ? "Waiting"
        : total === null
          ? "Working"
          : `${formatCount(done)} of ${formatCount(total)}`;

    return { phase, title, state: "running", detail };
  });
};

/** How the choice that skips a source user reads on iOS, in title case like Paper's actions. */
export const SKIP_LABEL = "Don’t Import";

/** The label of a row's current choice. */
export const choiceLabel = (row: UserRow): string =>
  row.options.find((option) => option.value === row.choice)?.label ?? SKIP_LABEL;
