import {
  Cache,
  Context,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  type PlatformError,
  Schema,
  Stream,
} from "effect";

import type { LibraryId } from "@media/contracts/ids";
import { SCAN_FAILURE_PREFIXES } from "@media/contracts/scan-failure";
import { createHash } from "node:crypto";

import * as MediaConfig from "../media-config.ts";
import { probeFile } from "../media/media-probe.ts";
import * as MediaTools from "../media/media-tools.ts";
import * as MetadataResolver from "../metadata/title-metadata.ts";
import { modifiedAtMs } from "../platform/file-info.ts";
import { type EntryKind, errorCode, listEntries } from "../platform/node-directories.ts";
import {
  ACTORS_FOLDER,
  actorImage,
  episodeThumb,
  type FolderListing,
  movieArtwork,
  seasonPoster,
  showArtwork,
} from "./artwork.ts";
import * as LibrarySink from "./library-sink.ts";
import { MediaName, parseMediaPath } from "./media-naming.ts";

type MovieName = Extract<MediaName, { readonly _tag: "Movie" }>;

type EpisodeName = Extract<MediaName, { readonly _tag: "Episode" }>;

import { type LocalMetadata, type NfoKind, parseNfo } from "./nfo.ts";
import { sidecarSubtitles } from "./sidecar-subtitles.ts";

/** How much of a library a scan re-reads. */
export type ScanMode = "incremental" | "full";

interface ScanRequest {
  readonly libraryId: LibraryId;
  readonly root: string;
  readonly mode: ScanMode;
}

interface ScanFailure {
  readonly relativePath: string;
  readonly reason: string;
}

/** What a finished scan did. */
export interface ScanSummary {
  readonly libraryId: LibraryId;
  readonly discovered: number;
  readonly unchanged: number;
  readonly processed: number;
  readonly failed: number;
  readonly missing: number;
  /** Symbolic links skipped because they point outside the library root. */
  readonly rejectedLinks: number;
  /** The first failures, for diagnostics. */
  readonly failures: ReadonlyArray<ScanFailure>;
}

/** The library folder is not inside an approved `LIBRARY_ROOTS` entry. */
export class LibraryRootNotApproved extends Schema.TaggedError<LibraryRootNotApproved>()(
  "LibraryRootNotApproved",
  { root: Schema.String },
) {
  override get message(): string {
    return `${SCAN_FAILURE_PREFIXES.rootNotApproved}: ${this.root} is outside LIBRARY_ROOTS`;
  }
}

/** The library folder cannot be read right now. Its files are not marked missing. */
export class LibraryRootUnavailable extends Schema.TaggedError<LibraryRootUnavailable>()(
  "LibraryRootUnavailable",
  {
    root: Schema.String,
    reason: Schema.Literals([
      "missing",
      "not-a-directory",
      "permission-denied",
      "unreadable",
      "empty",
    ]),
  },
) {
  override get message(): string {
    return `${SCAN_FAILURE_PREFIXES.rootUnavailable}: ${this.root} (${this.reason}); known files were left untouched`;
  }
}

class LibraryFolderUnreadable extends Schema.TaggedError<LibraryFolderUnreadable>()(
  "LibraryFolderUnreadable",
  { folder: Schema.String, code: Schema.String },
) {
  override get message(): string {
    return `${SCAN_FAILURE_PREFIXES.folderUnreadable}: ${this.folder === "" ? "(root)" : this.folder} (${this.code}); known files were left untouched`;
  }
}

/** Failures that stop a scan. */
export type ScanError =
  | LibraryRootNotApproved
  | LibraryRootUnavailable
  | LibraryFolderUnreadable
  | LibrarySink.LibrarySinkFailed;

/** Scans libraries. */
export interface Interface {
  readonly scan: (request: ScanRequest) => Effect.Effect<ScanSummary, ScanError>;
  /**
   * The real path of a library folder a scan may read: one that resolves, is a folder, and lies
   * inside `LIBRARY_ROOTS`. A scan checks this itself; a caller checks it before claiming the
   * folder, so an unapproved or missing folder fails the same way either side of the claim.
   */
  readonly openRoot: (
    root: string,
  ) => Effect.Effect<string, LibraryRootNotApproved | LibraryRootUnavailable>;
}

/** The library scanner. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/LibraryScanner",
) {}

const PROBE_CONCURRENCY = 8;

const STAT_CONCURRENCY = 16;

const WALK_CONCURRENCY = 4;

const BATCH_SIZE = 100;

const MAX_REPORTED_FAILURES = 50;

const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  "mkv",
  "mp4",
  "m4v",
  "mov",
  "avi",
  "webm",
  "ts",
  "m2ts",
  "mts",
  "wmv",
  "mpg",
  "mpeg",
  "flv",
  "ogv",
]);

/** Folders that file systems, NAS appliances, and desktops create for themselves. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  "lost+found",
  "@eadir",
  "#recycle",
  "#snapshot",
  "$recycle.bin",
  "system volume information",
]);

const isMediaFile = (name: string): boolean =>
  MEDIA_EXTENSIONS.has(name.split(".").at(-1)?.toLowerCase() ?? "");

const isSkipped = (name: string): boolean =>
  name.startsWith(".") || SKIPPED_FOLDERS.has(name.toLowerCase());

const parentOf = (relativePath: string): string => relativePath.split("/").slice(0, -1).join("/");

const stemOf = (relativePath: string): string =>
  (relativePath.split("/").at(-1) ?? relativePath).replace(/\.[^.]+$/, "");

const join = (folder: string, name: string): string => (folder === "" ? name : `${folder}/${name}`);

const isWithin = (root: string, candidate: string, separator: string): boolean =>
  candidate === root ||
  candidate.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);

const SEASON_FOLDER = /^(?:season|series|staffel|saison|s)[ ._-]*\d{1,3}$|^specials?$/i;

interface WalkResult {
  readonly folders: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly media: ReadonlyArray<string>;
  readonly rejectedLinks: number;
}

interface StatResult {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
  readonly sidecarDigest: string;
}

const COMPANION_EXTENSIONS = new Set([
  "nfo",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "tbn",
  "srt",
  "vtt",
  "ass",
  "ssa",
]);

interface FolderCompanions {
  readonly shared: ReadonlyArray<string>;
  readonly byStem: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly all: ReadonlyArray<string>;
}

const stemsOf = (lowerName: string): ReadonlyArray<string> => {
  const stems: Array<string> = [];

  for (let end = 0; end < lowerName.length; end += 1) {
    const char = lowerName[end];

    if (char === "." || char === "-") stems.push(lowerName.slice(0, end));
  }

  return stems;
};

const platformReason = (
  error: PlatformError.PlatformError,
): "missing" | "permission-denied" | "unreadable" =>
  Match.value(error.reason).pipe(
    Match.tag("NotFound", () => "missing" as const),
    Match.tag("PermissionDenied", () => "permission-denied" as const),
    Match.orElse(() => "unreadable" as const),
  );

const kindOfTarget = (type: FileSystem.File.Type): EntryKind =>
  Match.value(type).pipe(
    Match.when("Directory", () => "directory" as const),
    Match.when("File", () => "file" as const),
    Match.orElse(() => "other" as const),
  );

const isMainVideo =
  (folder: string) =>
  (name: string): boolean =>
    isMediaFile(name) && !MediaName.guards.Extra(parseMediaPath(join(folder, name)));

const holdsOneMovie = (mainVideos: ReadonlyArray<string>): boolean => {
  const movies = new Set(
    mainVideos.map((name) => {
      const parsed = parseMediaPath(name);

      return MediaName.guards.Movie(parsed)
        ? `${parsed.title.toLowerCase()}|${parsed.year ?? ""}`
        : `other|${name}`;
    }),
  );

  return movies.size === 1;
};

interface Described {
  readonly title: MetadataResolver.TitleMetadata | undefined;
  readonly episode: MetadataResolver.EpisodeMetadata | undefined;
}

interface Counters {
  discovered: number;
  unchanged: number;
  processed: number;
  failed: number;
  missing: number;
}

/** Builds a scanner over the `LibrarySink` in context, such as one scan job's own sink. */
export const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sink = yield* LibrarySink.Service;
  const resolver = yield* MetadataResolver.Service;
  const tools = yield* MediaTools.Service;

  const openRoot = Effect.fn("LibraryScanner.openRoot")(function* (root: string) {
    const realRoot = yield* fs
      .realPath(root)
      .pipe(
        Effect.mapError(
          (error) => new LibraryRootUnavailable({ root, reason: platformReason(error) }),
        ),
      );

    const approved = yield* Effect.forEach(config.libraryRoots, (approvedRoot) =>
      fs.realPath(approvedRoot).pipe(Effect.option),
    );

    const isApproved = approved.some(
      (candidate) => Option.isSome(candidate) && isWithin(candidate.value, realRoot, path.sep),
    );

    if (!isApproved) return yield* new LibraryRootNotApproved({ root });

    const info = yield* fs
      .stat(realRoot)
      .pipe(Effect.mapError(() => new LibraryRootUnavailable({ root, reason: "unreadable" })));

    if (info.type !== "Directory") {
      return yield* new LibraryRootUnavailable({ root, reason: "not-a-directory" });
    }

    return realRoot;
  });

  const walk = Effect.fn("LibraryScanner.walk")(function* (root: string, realRoot: string) {
    const folders = new Map<string, ReadonlyArray<string>>();
    const media: Array<string> = [];
    const visited = new Set<string>();
    let rejectedLinks = 0;

    const resolveEntry = Effect.fnUntraced(function* (child: string, kind: EntryKind) {
      if (kind !== "symlink") return kind;
      const target = yield* fs.realPath(path.join(root, child)).pipe(Effect.option);

      if (Option.isNone(target)) return "other" as const;

      if (!isWithin(realRoot, target.value, path.sep)) {
        rejectedLinks += 1;

        yield* Effect.logWarning("LibraryScanner.link_rejected").pipe(
          Effect.annotateLogs({ relativePath: child }),
        );

        return "other" as const;
      }

      const info = yield* fs.stat(target.value).pipe(Effect.option);

      return Option.match(info, {
        onNone: () => "other" as const,
        onSome: (stat) => kindOfTarget(stat.type),
      });
    });

    const visit = (relative: string): Effect.Effect<void, LibraryFolderUnreadable> =>
      Effect.gen(function* () {
        const absolute = relative === "" ? root : path.join(root, relative);
        const real = yield* fs.realPath(absolute).pipe(Effect.option);

        if (Option.isNone(real) || visited.has(real.value)) return;
        visited.add(real.value);

        const entries = yield* Effect.tryPromise({
          try: () => listEntries(absolute),
          catch: (cause) =>
            new LibraryFolderUnreadable({ folder: relative, code: errorCode(cause) }),
        }).pipe(
          Effect.asSome,
          Effect.catchIf(
            (error) => relative !== "" && error.code === "ENOENT",
            () => Effect.succeedNone,
          ),
        );

        if (Option.isNone(entries)) return;

        folders.set(
          relative,
          entries.value.map((entry) => entry.name),
        );

        const subfolders: Array<string> = [];

        for (const entry of entries.value) {
          if (isSkipped(entry.name)) continue;
          const child = join(relative, entry.name);
          const kind = yield* resolveEntry(child, entry.kind);

          if (kind === "directory") subfolders.push(child);
          else if (kind === "file" && isMediaFile(entry.name)) media.push(child);
        }

        yield* Effect.forEach(subfolders, visit, { concurrency: WALK_CONCURRENCY, discard: true });
      });

    yield* visit("");

    return { folders, media: media.toSorted(), rejectedLinks } satisfies WalkResult;
  });

  const scan = Effect.fn("LibraryScanner.scan")(
    function* (request: ScanRequest) {
      const { libraryId, root } = request;
      const libraryFolder = { libraryId, root };
      const realRoot = yield* openRoot(root);

      const previous = new Map(
        (yield* sink.previousIndex(libraryFolder)).map((file) => [file.relativePath, file]),
      );

      const counters: Counters = {
        discovered: 0,
        unchanged: 0,
        processed: 0,
        failed: 0,
        missing: 0,
      };

      const failures: Array<ScanFailure> = [];

      const report = (phase: LibrarySink.ScanProgress["phase"]) =>
        sink.reportProgress(libraryFolder, {
          phase,
          discovered: counters.discovered,
          unchanged: counters.unchanged,
          processed: counters.processed,
          failed: counters.failed,
          missing: counters.missing,
        });

      yield* report("walking");
      const walked = yield* walk(root, realRoot);

      if (walked.media.length === 0 && previous.size > 0) {
        return yield* new LibraryRootUnavailable({ root, reason: "empty" });
      }

      counters.discovered = walked.media.length;
      yield* report("processing");

      const listing = (folder: string): FolderListing => ({
        folder,
        names: walked.folders.get(folder) ?? [],
      });

      const absolute = (relativePath: string): string =>
        path.join(root, ...relativePath.split("/"));

      const mainVideosByFolder = new Map<string, ReadonlyArray<string>>();

      const mainVideos = (folder: string): ReadonlyArray<string> => {
        const known = mainVideosByFolder.get(folder);

        if (known !== undefined) return known;

        const found = listing(folder).names.filter(isMainVideo(folder));

        mainVideosByFolder.set(folder, found);

        return found;
      };

      const folderCompanions = yield* Cache.make({
        capacity: 10_000,
        lookup: (folder: string) =>
          Effect.gen(function* () {
            const names = listing(folder).names;

            const companions = yield* Effect.forEach(
              names.filter(
                (name) =>
                  COMPANION_EXTENSIONS.has(name.split(".").at(-1)?.toLowerCase() ?? "") &&
                  !walked.folders.has(join(folder, name)),
              ),
              (name) =>
                fs.stat(absolute(join(folder, name))).pipe(
                  Effect.map((info) => ({
                    name,
                    line: `${name}\u0000${String(info.size)}\u0000${String(modifiedAtMs(info))}`,
                  })),
                  Effect.orElseSucceed(() => ({ name, line: `${name}\u0000unreadable` })),
                ),
              { concurrency: STAT_CONCURRENCY },
            );

            const actors = yield* fs.stat(absolute(join(folder, ".actors"))).pipe(
              Effect.map((info) =>
                info.type === "Directory"
                  ? [{ name: ".actors", line: `.actors/\u0000${String(modifiedAtMs(info))}` }]
                  : [],
              ),
              Effect.orElseSucceed(() => []),
            );

            const videoStems = new Set(
              mainVideos(folder).map((name) => stemOf(name).toLowerCase()),
            );

            const shared: Array<string> = [];
            const byStem = new Map<string, Array<string>>();

            const entries = [...companions, ...actors];

            for (const { name, line } of entries) {
              const stems = stemsOf(name.toLowerCase());

              if (!stems.some((stem) => videoStems.has(stem))) {
                shared.push(line);
                continue;
              }

              for (const stem of stems) {
                const owned = byStem.get(stem);

                if (owned === undefined) byStem.set(stem, [line]);
                else owned.push(line);
              }
            }

            return {
              shared,
              byStem,
              all: entries.map(({ line }) => line),
            } satisfies FolderCompanions;
          }),
      });

      const sidecarDigest = Effect.fn("LibraryScanner.sidecarDigest")(function* (
        relativePath: string,
      ) {
        const folder = parentOf(relativePath);
        const stem = stemOf(relativePath).toLowerCase();

        const own = yield* Cache.get(folderCompanions, folder);
        const lines = [...own.shared, ...(own.byStem.get(stem) ?? [])];

        const inSeasonFolder =
          folder.includes("/") && SEASON_FOLDER.test(folder.split("/").at(-1) ?? "");

        const show = inSeasonFolder
          ? (yield* Cache.get(folderCompanions, parentOf(folder))).all
          : [];

        return createHash("sha256")
          .update([...lines.toSorted(), "", ...show.toSorted()].join("\n"))
          .digest("base64url");
      });

      const nfoCache = yield* Cache.make({
        capacity: 10_000,
        lookup: ([relativePath, kind, episode]: readonly [string, NfoKind, number | undefined]) =>
          fs.realPath(absolute(relativePath)).pipe(
            Effect.filterOrFail((real) => isWithin(realRoot, real, path.sep)),
            Effect.flatMap((real) => fs.readFileString(real)),
            Effect.map((text) => Option.fromNullishOr(parseNfo(text, kind, episode))),
            Effect.orElseSucceed(() => Option.none<LocalMetadata>()),
          ),
      });

      const readNfo = (
        folder: string,
        candidates: ReadonlyArray<string>,
        kind: NfoKind,
        episode?: number,
      ) => {
        const byLowerName = new Map(
          listing(folder).names.map((name) => [name.toLowerCase(), name]),
        );

        const found = candidates
          .map((candidate) => byLowerName.get(candidate.toLowerCase()))
          .find((name) => name !== undefined);

        return found === undefined
          ? Effect.succeedNone
          : Cache.get(nfoCache, [join(folder, found), kind, episode] as const);
      };

      const actorsCache = yield* Cache.make({
        capacity: 10_000,
        lookup: (folder: string) => {
          const relative = join(folder, ACTORS_FOLDER);
          const present = listing(folder).names.some((name) => name === ACTORS_FOLDER);

          return present
            ? fs.realPath(absolute(relative)).pipe(
                Effect.filterOrFail((real) => isWithin(realRoot, real, path.sep)),
                Effect.flatMap((real) => fs.readDirectory(real)),
                Effect.map((names): FolderListing => ({ folder: relative, names })),
                Effect.orElseSucceed((): FolderListing => ({ folder: relative, names: [] })),
              )
            : Effect.succeed<FolderListing>({ folder: relative, names: [] });
        },
      });

      const actorImagesIn = Effect.fnUntraced(function* (folders: ReadonlyArray<string>) {
        const listings = yield* Effect.forEach(folders, (folder) => Cache.get(actorsCache, folder));

        return (name: string): string | undefined =>
          listings.map((found) => actorImage(found, name)).find((image) => image !== undefined);
      });

      const showCache = yield* Cache.make({
        capacity: 10_000,
        lookup: ([showFolder, showTitle, showYear, tvdb, tmdb, imdb]: readonly [
          string | undefined,
          string,
          number | undefined,
          string | undefined,
          string | undefined,
          string | undefined,
        ]) =>
          Effect.gen(function* () {
            const local =
              showFolder === undefined
                ? Option.none()
                : yield* readNfo(showFolder, ["tvshow.nfo"], "show");

            return yield* resolver.title({
              kind: "show",
              title: showTitle,
              year: showYear,
              nameIds: { tvdb, tmdb, imdb },
              local: Option.getOrUndefined(local),
              artwork: showFolder === undefined ? {} : showArtwork(listing(showFolder)),
              actorImages: yield* actorImagesIn(showFolder === undefined ? [] : [showFolder]),
            });
          }),
      });

      const ownFolders = new Map<string, boolean>();

      const isOwnFolder = (folder: string): boolean => {
        const known = ownFolders.get(folder);

        if (known !== undefined) return known;

        const own = folder !== "" && holdsOneMovie(mainVideos(folder));

        ownFolders.set(folder, own);

        return own;
      };

      const describeMovie = Effect.fn("LibraryScanner.describeMovie")(function* (
        relativePath: string,
        name: MovieName,
      ) {
        const folder = parentOf(relativePath);
        const stem = stemOf(relativePath);
        const ownFolder = isOwnFolder(folder);

        const local = yield* readNfo(
          folder,
          ownFolder ? [`${stem}.nfo`, "movie.nfo"] : [`${stem}.nfo`],
          "movie",
        );

        const resolved = yield* resolver.title({
          kind: "movie",
          title: name.title,
          year: name.year,
          nameIds: name.ids,
          local: Option.getOrUndefined(local),
          artwork: movieArtwork(relativePath, listing(folder), ownFolder),
          actorImages: yield* actorImagesIn([folder]),
        });

        return { title: resolved.metadata, episode: undefined };
      });

      const describeEpisode = Effect.fn("LibraryScanner.describeEpisode")(function* (
        relativePath: string,
        name: EpisodeName,
      ) {
        const folder = parentOf(relativePath);
        const inSeasonFolder = SEASON_FOLDER.test(folder.split("/").at(-1) ?? "");
        const showFolderPath = inSeasonFolder ? parentOf(folder) : folder;
        const showFolder = showFolderPath === "" ? undefined : showFolderPath;

        const show = yield* Cache.get(showCache, [
          showFolder,
          name.showTitle,
          name.showYear,
          name.showIds.tvdb,
          name.showIds.tmdb,
          name.showIds.imdb,
        ] as const);

        const local = yield* readNfo(
          folder,
          [`${stemOf(relativePath)}.nfo`],
          "episode",
          name.episodes[0],
        );

        const episode = yield* resolver.episode(show.providerId, {
          name,
          local: Option.getOrUndefined(local),
          still: episodeThumb(relativePath, listing(folder)),
          actorImages: yield* actorImagesIn(
            showFolder === undefined || showFolder === folder ? [folder] : [folder, showFolder],
          ),
          seasonPoster:
            showFolder === undefined
              ? undefined
              : seasonPoster(
                  name.season,
                  listing(showFolder),
                  inSeasonFolder ? listing(folder) : undefined,
                ),
        });

        return { title: show.metadata, episode };
      });

      const describe = (relativePath: string, name: MediaName): Effect.Effect<Described> =>
        MediaName.match(name, {
          Movie: (movie) => describeMovie(relativePath, movie),
          Episode: (episode) => describeEpisode(relativePath, episode),
          Extra: () => Effect.succeed<Described>({ title: undefined, episode: undefined }),
        });

      const fail = (relativePath: string, reason: string) =>
        Effect.gen(function* () {
          counters.failed += 1;

          if (failures.length < MAX_REPORTED_FAILURES) failures.push({ relativePath, reason });

          yield* Effect.logWarning("LibraryScanner.file_failed").pipe(
            Effect.annotateLogs({ relativePath, reason }),
          );
        });

      const statFile = (relativePath: string) =>
        Effect.all([fs.stat(absolute(relativePath)), sidecarDigest(relativePath)]).pipe(
          Effect.map(([info, digest]): StatResult => ({
            relativePath,
            sizeBytes: Number(info.size),
            modifiedAtMs: modifiedAtMs(info),
            sidecarDigest: digest,
          })),
          Effect.asSome,
          Effect.catch((error) =>
            fail(relativePath, platformReason(error)).pipe(Effect.as(Option.none<StatResult>())),
          ),
        );

      const isUnchanged = (file: StatResult): boolean => {
        const known = previous.get(file.relativePath);

        return (
          request.mode === "incremental" &&
          known !== undefined &&
          known.sizeBytes === file.sizeBytes &&
          known.modifiedAtMs === file.modifiedAtMs &&
          known.sidecarDigest === file.sidecarDigest
        );
      };

      const processFile = (file: StatResult) =>
        Effect.gen(function* () {
          const probe = yield* probeFile(absolute(file.relativePath)).pipe(
            Effect.provideService(MediaTools.Service, tools),
          );

          const name = parseMediaPath(file.relativePath);
          const described = yield* describe(file.relativePath, name);

          const scanned: LibrarySink.ScannedFile = {
            relativePath: file.relativePath,
            sizeBytes: file.sizeBytes,
            modifiedAtMs: file.modifiedAtMs,
            sidecarDigest: file.sidecarDigest,
            name,
            probe,
            subtitles: sidecarSubtitles(file.relativePath, listing(parentOf(file.relativePath))),
            title: described.title,
            episode: described.episode,
          };

          return Option.some(scanned);
        }).pipe(
          Effect.catchTags({
            MediaToolFailed: (error) =>
              fail(file.relativePath, `ffprobe exited with ${String(error.exitCode)}`).pipe(
                Effect.as(Option.none<LibrarySink.ScannedFile>()),
              ),
            MediaProbeInvalid: () =>
              fail(file.relativePath, "ffprobe output was not a media description").pipe(
                Effect.as(Option.none<LibrarySink.ScannedFile>()),
              ),
          }),
        );

      const skipUnchanged = Effect.sync(() => {
        counters.unchanged += 1;

        return Option.none<LibrarySink.ScannedFile>();
      });

      yield* Stream.fromIterable(walked.media).pipe(
        Stream.mapEffect(statFile, { concurrency: STAT_CONCURRENCY }),
        Stream.filter(Option.isSome),
        Stream.map((stat) => stat.value),
        Stream.mapEffect((file) => (isUnchanged(file) ? skipUnchanged : processFile(file)), {
          concurrency: PROBE_CONCURRENCY,
          unordered: true,
        }),
        Stream.filter(Option.isSome),
        Stream.map((scanned) => scanned.value),
        Stream.grouped(BATCH_SIZE),
        Stream.runForEach((batch) =>
          Effect.gen(function* () {
            yield* sink.upsertBatch(libraryFolder, batch);
            counters.processed += batch.length;
            yield* report("processing");
          }),
        ),
      );

      const present = new Set(walked.media);
      const missing = [...previous.keys()].filter((relativePath) => !present.has(relativePath));

      counters.missing = missing.length;
      yield* report("reconciling");

      yield* Effect.forEach(
        Array.from({ length: Math.ceil(missing.length / BATCH_SIZE) }, (_, index) =>
          missing.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
        ),
        (batch) => sink.markMissing(libraryFolder, batch),
        { discard: true },
      );

      yield* report("done");

      return {
        libraryId,
        discovered: counters.discovered,
        unchanged: counters.unchanged,
        processed: counters.processed,
        failed: counters.failed,
        missing: counters.missing,
        rejectedLinks: walked.rejectedLinks,
        failures,
      } satisfies ScanSummary;
    },
    (effect, request) => effect.pipe(Effect.annotateLogs({ libraryId: request.libraryId })),
  );

  return Service.of({ scan, openRoot });
});

/** The scanner with its dependencies left open for composition. */
export const layer: Layer.Layer<
  Service,
  never,
  | MediaConfig.Service
  | FileSystem.FileSystem
  | Path.Path
  | LibrarySink.Service
  | MetadataResolver.Service
  | MediaTools.Service
> = Layer.effect(Service, make);
