import { normalizeFolder } from "@media/contracts/library-folder";
import { NotFound } from "@media/contracts/errors";
import type { ServerFolder, ServerFolders } from "@media/contracts/models/catalog";
import { Effect, FileSystem, Option, Path } from "effect";

import * as MediaConfig from "../media-config.ts";
import { listEntries } from "../platform/node-directories.ts";
import { approvedRoots } from "../playback/file-resolver.ts";

const MAX_FOLDERS = 1000;

const MAX_LINKS = 1000;

const CHECK_CONCURRENCY = 16;

const byName = (a: string, b: string): number =>
  a.localeCompare(b, "en", { sensitivity: "base", numeric: true });

const unavailable = (folder: string) =>
  new NotFound({ message: `${folder} isn’t available to the server` });

const isDirectory = (fs: FileSystem.FileSystem, path: string) =>
  fs.stat(path).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );

const hasDotSegments = (folder: string): boolean =>
  folder.split("/").some((segment) => segment === "." || segment === "..");

const isWithin = (root: string, folder: string): boolean =>
  folder === root || folder.startsWith(root === "/" ? "/" : `${root}/`);

/** Lists `folder`, or the approved roots that exist now when it is omitted. */
export const list = Effect.fn("ServerFolders.list")(function* (folder: string | undefined) {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots = config.libraryRoots.map(normalizeFolder);

  if (folder === undefined) {
    const present = yield* Effect.filter(roots, (root) => isDirectory(fs, root), {
      concurrency: "unbounded",
    });

    return {
      path: null,
      parent: null,
      folders: present.map((root): ServerFolder => ({ name: root, path: root })),
      truncated: false,
    } satisfies ServerFolders;
  }

  const requested = normalizeFolder(folder);

  if (hasDotSegments(requested) || !roots.some((root) => isWithin(root, requested))) {
    return yield* unavailable(requested);
  }

  const approved = yield* approvedRoots();
  const real = yield* approved.realPathInside(requested);

  if (Option.isNone(real)) return yield* unavailable(requested);

  const entries = yield* Effect.tryPromise({
    try: () => listEntries(real.value),
    catch: () => unavailable(requested),
  });

  const visible = entries.filter((entry) => !entry.name.startsWith("."));

  const folders = visible.flatMap((entry) => (entry.kind === "directory" ? [entry.name] : []));
  const links = visible.flatMap((entry) => (entry.kind === "symlink" ? [entry.name] : []));
  const followed = links.toSorted(byName).slice(0, MAX_LINKS);

  const linkedFolders = yield* Effect.filter(
    followed,
    (name) =>
      approved.realPathInside(path.join(real.value, name)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(false),
            onSome: (inside) => isDirectory(fs, inside),
          }),
        ),
      ),
    { concurrency: CHECK_CONCURRENCY },
  );

  const all = [...folders, ...linkedFolders].toSorted(byName);

  return {
    path: requested,
    parent: roots.includes(requested) ? null : path.dirname(requested),
    folders: all
      .slice(0, MAX_FOLDERS)
      .map((name): ServerFolder => ({ name, path: path.join(requested, name) })),
    truncated: all.length > MAX_FOLDERS || links.length > followed.length,
  } satisfies ServerFolders;
});
