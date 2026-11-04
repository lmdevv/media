import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { format } from "oxfmt";

import { check } from "./check.ts";
import { byCodeUnits } from "./order.ts";
import { GENERATED_MARK } from "./note.ts";
import type { CheckedCommand, Declaration, Refusal } from "./check.ts";

/** A file an output writes, relative to that output's folder, before formatting. */
export interface Emitted {
  readonly path: string;
  readonly text: string;
}

/**
 * One output of the generator, such as the core's Convex functions or the skill reference. It owns
 * `root`, a folder relative to the repo: every file under it is generated, and a file it no longer
 * emits is deleted.
 */
export interface Target {
  readonly root: string;
  readonly emit: (commands: ReadonlyArray<CheckedCommand>) => ReadonlyArray<Emitted>;
}

/** A formatted file and its path relative to the repo, with `/` separators. */
interface PlannedFile {
  readonly path: string;
  readonly text: string;
}

/** Every file the outputs should hold, and the folders they own. */
export interface Planned {
  readonly roots: ReadonlyArray<string>;
  readonly files: ReadonlyArray<PlannedFile>;
}

/** The generator's plan: the files to hold, or the refusals that stop it writing anything. */
export type Plan =
  | { readonly ok: true; readonly planned: Planned }
  | { readonly ok: false; readonly refusals: ReadonlyArray<Refusal> };

/** A difference between the plan and the files on disk. */
export interface Drift {
  /**
   * `stale`: the file differs. `missing`: it is not there. `extra`: a generated file no command
   * writes anymore. `foreign`: a file the generator did not write, which it never deletes.
   */
  readonly kind: "stale" | "missing" | "extra" | "foreign";
  readonly path: string;
}

/** What `write` changed, or the files it found in its folders but did not write, which stop it. */
export type Report =
  | {
      readonly ok: true;
      readonly written: ReadonlyArray<string>;
      readonly deleted: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly foreign: ReadonlyArray<string> };

const formatted = async (path: string, text: string): Promise<string> => {
  const result = await format(path, text);

  if (result.errors.length > 0) {
    throw new Error(
      `The generator emitted ${path} that oxfmt cannot format: ${result.errors.map((error) => error.message).join("; ")}`,
    );
  }

  return result.code;
};

/**
 * Checks the declarations, emits every output, and formats each file in memory as `pnpm fmt`
 * would. It reads no files, so the same declarations always give the same plan.
 */
export const plan = async (
  declarations: ReadonlyArray<Declaration>,
  targets: ReadonlyArray<Target>,
): Promise<Plan> => {
  const checked = check(declarations);

  if (!checked.ok) return checked;

  const files = targets.flatMap((target) =>
    target.emit(checked.commands).map((emitted) => ({
      path: `${target.root}/${emitted.path}`,
      text: emitted.text,
    })),
  );

  const repeated = [...Map.groupBy(files, (file) => file.path)].flatMap(([path, group]) =>
    group.length > 1 ? [path] : [],
  );

  if (repeated.length > 0) throw new Error(`Two outputs emitted ${repeated.join(", ")}`);

  const roots = targets.map((target) => target.root);

  const overlapping = roots.flatMap((root) =>
    roots.filter((other) => other !== root && other.startsWith(`${root}/`)),
  );

  if (overlapping.length > 0) {
    throw new Error(`An output folder holds another output's folder: ${overlapping.join(", ")}`);
  }

  return {
    ok: true,
    planned: {
      roots: targets.map((target) => target.root),
      files: await Promise.all(
        files.map(async (file) => ({
          path: file.path,
          text: await formatted(file.path, file.text),
        })),
      ),
    },
  };
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const filesUnder = async (repo: string, root: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(join(repo, root), { recursive: true, withFileTypes: true }).catch(
    (cause: unknown) => {
      if (isMissing(cause)) return [];

      throw cause;
    },
  );

  return entries.flatMap((entry) =>
    entry.isDirectory()
      ? []
      : [relative(repo, join(entry.parentPath, entry.name)).split(sep).join("/")],
  );
};

const contents = async (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch((cause: unknown) => {
    if (isMissing(cause)) return undefined;

    throw cause;
  });

/** Compares the plan with the repo at `repo`: stale and missing files, and extras under each root. */
export const drift = async (repo: string, planned: Planned): Promise<ReadonlyArray<Drift>> => {
  const planPaths = new Set(planned.files.map((file) => file.path));

  const changed = await Promise.all(
    planned.files.map(async (file): Promise<ReadonlyArray<Drift>> => {
      const current = await contents(join(repo, file.path));

      if (current === undefined) return [{ kind: "missing", path: file.path }];

      return current === file.text ? [] : [{ kind: "stale", path: file.path }];
    }),
  );

  const unplanned = (
    await Promise.all(planned.roots.map(async (root) => filesUnder(repo, root)))
  ).flatMap((paths) => paths.filter((path) => !planPaths.has(path)));

  const extras = await Promise.all(
    unplanned.map(async (path): Promise<Drift> => {
      const current = await contents(join(repo, path));

      return {
        kind: current?.includes(GENERATED_MARK) === true ? "extra" : "foreign",
        path,
      };
    }),
  );

  return [...changed.flat(), ...extras].toSorted((left, right) =>
    byCodeUnits(left.path, right.path),
  );
};

/**
 * Brings the repo at `repo` to the plan: writes stale and missing files, deletes extras, and leaves
 * every other file alone. A second run finds nothing to do, and a run that stops halfway is
 * finished by the next.
 */
export const write = async (repo: string, planned: Planned): Promise<Report> => {
  const differences = await drift(repo, planned);

  const foreign = differences.flatMap((difference) =>
    difference.kind === "foreign" ? [difference.path] : [],
  );

  if (foreign.length > 0) return { ok: false, foreign };

  const texts = new Map(planned.files.map((file) => [file.path, file.text]));

  const writes = differences.flatMap((difference) => {
    const text = texts.get(difference.path);

    return difference.kind !== "extra" && text !== undefined
      ? [{ path: difference.path, text }]
      : [];
  });

  const extras = differences.flatMap((difference) =>
    difference.kind === "extra" ? [difference.path] : [],
  );

  await Promise.all(
    writes.map(async ({ path, text }) => {
      const absolute = join(repo, path);

      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, text);
    }),
  );

  await Promise.all(extras.map(async (path) => rm(join(repo, path))));

  return { ok: true, written: writes.map((file) => file.path), deleted: extras };
};

const DRIFT_FIXES = {
  stale: "stale, run `pnpm --filter @media/commands generate`",
  missing: "missing, run `pnpm --filter @media/commands generate`",
  extra: "no command writes it, run `pnpm --filter @media/commands generate` to delete it",
  foreign: "not written by @media/commands, move it out of this generated folder",
} as const satisfies { readonly [Kind in Drift["kind"]]: string };

/** One line that names a drifted file and how to fix it. */
export const driftMessage = (difference: Drift): string =>
  `${difference.path}: ${DRIFT_FIXES[difference.kind]}`;
