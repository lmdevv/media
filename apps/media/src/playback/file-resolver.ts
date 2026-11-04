import { type FileResolverUnavailable, MediaFileNotFound } from "@media/contracts/media-playback";
import { Context, Effect, FileSystem, Option, Path, Schema, Struct } from "effect";

import type { MediaFileId } from "@media/contracts/ids";
import { SidecarFormat } from "../library/sidecar-subtitles.ts";
import * as MediaConfig from "../media-config.ts";
import type { MediaProbe } from "../media/media-probe.ts";

const ResolvedSidecar = Schema.Struct({
  path: Schema.String,
  format: SidecarFormat,
  language: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  forced: Schema.Boolean,
  hearingImpaired: Schema.Boolean,
  default: Schema.Boolean,
});

interface ResolvedSidecar extends Schema.Schema.Type<typeof ResolvedSidecar> {}

/** Everything playback needs about one stored media file. */
export interface ResolvedMediaFile {
  readonly fileId: MediaFileId;
  /** Absolute path; `resolveInsideRoots` has checked it lies inside an approved library root. */
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
  readonly probe: MediaProbe;
  readonly subtitles: ReadonlyArray<ResolvedSidecar>;
}

/**
 * A sidecar `resolveInsideRoots` checked. `path` stays as recorded: track IDs come from its file
 * name, so two links to one file stay two tracks. `readPath` is the canonical path to open.
 */
export interface CheckedSidecar extends ResolvedSidecar {
  readonly readPath: string;
}

/** A media file whose path, and sidecars when asked for, are checked against the library roots. */
export interface CheckedMediaFile extends Omit<ResolvedMediaFile, "subtitles"> {
  readonly subtitles: ReadonlyArray<CheckedSidecar>;
}

/** Resolves stored file IDs. */
export interface Interface {
  readonly resolve: (
    fileId: MediaFileId,
  ) => Effect.Effect<ResolvedMediaFile, MediaFileNotFound | FileResolverUnavailable>;
}

/** The file resolver. */
export class Service extends Context.Service<Service, Interface>()("@media/server/FileResolver") {}

const isWithin = (root: string, candidate: string, separator: string): boolean =>
  candidate === root ||
  candidate.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);

/**
 * Checks paths against the approved library roots (`LIBRARY_ROOTS`) as they resolve now, after
 * following symbolic links; roots that do not resolve (an unmounted share) approve nothing.
 * `realPathInside` answers the canonical path of a candidate inside them, or none for a path
 * outside them or one that does not exist. Callers open the canonical path, so a link swapped
 * after the check cannot redirect them.
 */
export const approvedRoots = Effect.fnUntraced(function* () {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const roots = (yield* Effect.forEach(
    config.libraryRoots,
    (root) => fs.realPath(root).pipe(Effect.option),
    { concurrency: "unbounded" },
  )).flatMap((root) => (Option.isSome(root) ? [root.value] : []));

  const realPathInside = (candidate: string) =>
    fs.realPath(candidate).pipe(
      Effect.map((real) =>
        roots.some((root) => isWithin(root, real, path.sep)) ? Option.some(real) : Option.none(),
      ),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  return { realPathInside };
});

/**
 * The canonical path of `candidate` when, after following symbolic links, it lies inside an
 * approved library root (`LIBRARY_ROOTS`); none for a path outside them or one that does not
 * exist. Open the returned path, not `candidate`, so a link swapped after the check cannot
 * redirect the read.
 */
export const realPathInsideApprovedRoots = Effect.fn("FileResolver.realPathInsideApprovedRoots")(
  function* (candidate: string) {
    const roots = yield* approvedRoots();

    return yield* roots.realPathInside(candidate);
  },
);

/**
 * Resolves `fileId` and checks that the media file, after following symbolic links, lies inside
 * an approved library root; the result carries its canonical path. With `sidecars`, its subtitle
 * files are checked the same way and those outside the roots dropped; without, they are left out,
 * since byte-range and trickplay requests never read them. A file outside the roots is reported
 * as not found and logged; its path is never returned to the client.
 */
export const resolveInsideRoots = Effect.fn("FileResolver.resolveInsideRoots")(function* (
  fileId: MediaFileId,
  options: { readonly sidecars: boolean },
) {
  const resolver = yield* Service;
  const file = yield* resolver.resolve(fileId);
  const roots = yield* approvedRoots();
  const real = yield* roots.realPathInside(file.path);

  if (Option.isNone(real)) {
    yield* Effect.logError("FileResolver.path_rejected").pipe(Effect.annotateLogs({ fileId }));

    return yield* new MediaFileNotFound({ fileId });
  }

  const checked = options.sidecars
    ? yield* Effect.forEach(
        file.subtitles,
        (subtitle) =>
          Effect.map(roots.realPathInside(subtitle.path), (inside) => ({ subtitle, inside })),
        { concurrency: "unbounded" },
      )
    : [];

  const subtitles = checked.flatMap(({ subtitle, inside }): ReadonlyArray<CheckedSidecar> =>
    Option.isSome(inside) ? [Struct.assign(subtitle, { readPath: inside.value })] : [],
  );

  return { ...file, path: real.value, subtitles } satisfies CheckedMediaFile;
});
