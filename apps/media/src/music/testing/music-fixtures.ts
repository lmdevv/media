/**
 * What music's Effect tests build on: temporary folders in a scope, an in-memory stand-in for the
 * core's music scanner functions, the transcoder over the real tools, and ffprobe's reading.
 */
import { NodeServices } from "@effect/platform-node";
import type { KnownTrack, ScannedLyrics, ScannedTrack } from "@media/contracts/models/music";
import { Effect, Layer, Ref, Schema, type Scope } from "effect";

import * as CachePruner from "../../cache-pruner.ts";
import * as MediaTools from "../../media/media-tools.ts";
import { testConfigLayer } from "../../testing/test-config.ts";
import type { PathRange, ScanCatalog, TrackMove } from "../music-scan.ts";
import * as MusicTranscoder from "../transcoder.ts";
import {
  coreFingerprint,
  ffmpeg,
  ffprobe,
  makeDirectory,
  namesIn,
  removeDirectory,
  writeSong,
} from "./music-songs.ts";

export {
  coreFingerprint,
  makeDirectory,
  MEDIA_TEST_TIMEOUT,
  moveFile,
  PNG,
  removeDirectory,
  replaceInPlace,
  resizeFile,
  setFileTime,
  sizeOf,
  writeBytes,
  writeSong,
} from "./music-songs.ts";

/** A fresh folder under the system temp folder, removed when the scope closes. */
export const temporaryDirectory = (label: string): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(() => makeDirectory(label)),
    (path) => Effect.promise(() => removeDirectory(path)),
  );

/** Runs `effect` with a fresh scope, rejecting when it fails. */
export const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

/** Runs ffmpeg with `args` to completion, as a test builds its files. */
export const runFfmpeg = (args: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.promise(() => ffmpeg(args));

/** The names in a folder, or none for a folder that is not there. */
export const listNames = (path: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.promise(() => namesIn(path));

/**
 * The fixture song a test reads, written under a fresh folder: `relativePath` holding `seconds`
 * of a tone. Answers the folder.
 */
export const songLibrary = (
  relativePath: string,
  seconds = 4,
): Effect.Effect<string, never, Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("library");

    yield* Effect.promise(() => writeSong(`${root}/${relativePath}`, { seconds }));

    return root;
  });

/**
 * Music's transcoder over the real tools and its own cache pruner, caching under `dataDir`, with
 * `ffmpegPath` if given and any other `settings`.
 */
export const transcoderWith = (
  dataDir: string,
  ffmpegPath = "ffmpeg",
  settings: Readonly<Record<string, string>> = {},
) =>
  Layer.build(
    MusicTranscoder.layer.pipe(
      Layer.provide(MediaTools.layer),
      Layer.provide(CachePruner.layer),
      Layer.provide(testConfigLayer({ ...settings, DATA_DIR: dataDir, FFMPEG_PATH: ffmpegPath })),
      Layer.provide(NodeServices.layer),
    ),
  ).pipe(Effect.flatMap((context) => MusicTranscoder.Service.pipe(Effect.provideContext(context))));

const Probe = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      codec_type: Schema.String,
      codec_name: Schema.String,
      sample_rate: Schema.optionalKey(Schema.String),
      channels: Schema.optionalKey(Schema.Finite),
    }),
  ),
  format: Schema.Struct({ format_name: Schema.String, duration: Schema.String }),
});

/** Reads a media file with ffprobe; dies when ffprobe cannot parse it. */
export const probe = (path: string) =>
  Effect.promise(() =>
    ffprobe([
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,sample_rate,channels:format=format_name,duration",
      "-of",
      "json",
      path,
    ]),
  ).pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Probe))), Effect.orDie);

/** A track's own lyrics as the in-memory catalog keeps them. */
type KeptLyrics = Pick<ScannedTrack, "lyricsFiles" | "lyricsReader" | "lyrics">;

/** A track the in-memory catalog keeps, as the core's `tracks` and `localLyrics` rows would. */
export interface KeptTrack {
  readonly track: ScannedTrack;
  readonly missing: boolean;
  readonly lyrics: KeptLyrics;
}

/** What one scan sent the in-memory catalog. */
export interface CatalogWrites {
  readonly upserted: ReadonlyArray<string>;
  readonly moved: ReadonlyArray<TrackMove>;
  readonly missing: ReadonlyArray<string>;
  readonly lyrics: ReadonlyArray<string>;
}

/** An in-memory stand-in for the core's music scanner functions, with what it was sent. */
export interface MemoryCatalog {
  readonly catalog: ScanCatalog<never>;
  readonly tracks: Effect.Effect<ReadonlyMap<string, KeptTrack>>;
  /** What the catalog was sent since the last call, and forgets it. */
  readonly writes: Effect.Effect<CatalogWrites>;
}

const NO_WRITES: CatalogWrites = { upserted: [], moved: [], missing: [], lyrics: [] };

const kept = (track: ScannedTrack): KeptTrack => ({
  track,
  missing: false,
  lyrics: {
    lyricsFiles: track.lyricsFiles,
    lyricsReader: track.lyricsReader,
    lyrics: track.lyrics,
  },
});

const knownOf = ({ track, missing, lyrics }: KeptTrack): KnownTrack => ({
  path: track.path,
  size: track.size,
  mtimeMs: track.mtimeMs,
  missing,
  folderArt: track.folderArt === undefined ? null : coreFingerprint(track.folderArt),
  lyricsFiles: coreFingerprint(lyrics.lyricsFiles),
  lyricsReader: lyrics.lyricsReader,
  lyricsBytes: lyrics.lyrics.length === 0 ? null : Buffer.byteLength(JSON.stringify(lyrics.lyrics)),
  durationMs: track.durationMs,
  title: track.title,
  artist: track.artist,
  album: track.album,
});

const inRange = (path: string, range: PathRange): boolean =>
  (range.from === undefined || path >= range.from) && (range.to === undefined || path < range.to);

/**
 * The core's music scanner functions in memory: `known` answers rows in a range, `upsert` keeps
 * tracks, `move` keeps a track under its new path, `missing` marks rows, and `lyrics` replaces a
 * track's lyrics, as `music/scanner.ts` does. No artwork is ever released.
 */
export const memoryCatalog = Effect.gen(function* () {
  const rows = yield* Ref.make<ReadonlyMap<string, KeptTrack>>(new Map());
  const sent = yield* Ref.make<CatalogWrites>(NO_WRITES);

  const record = (change: Partial<CatalogWrites>) =>
    Ref.update(sent, (current) => ({
      upserted: [...current.upserted, ...(change.upserted ?? [])],
      moved: [...current.moved, ...(change.moved ?? [])],
      missing: [...current.missing, ...(change.missing ?? [])],
      lyrics: [...current.lyrics, ...(change.lyrics ?? [])],
    }));

  const changed = (change: (next: Map<string, KeptTrack>) => void) =>
    Ref.update(rows, (all) => {
      const next = new Map(all);

      change(next);

      return next;
    });

  const catalog: ScanCatalog<never> = {
    known: (range) =>
      Ref.get(rows).pipe(
        Effect.map((all) =>
          all
            .values()
            .filter((row) => inRange(row.track.path, range))
            .map(knownOf)
            .toArray(),
        ),
      ),
    upsert: (tracks: ReadonlyArray<ScannedTrack>) =>
      changed((next) => {
        for (const track of tracks) next.set(track.path, kept(track));
      }).pipe(
        Effect.andThen(record({ upserted: tracks.map((track) => track.path) })),
        Effect.as([]),
      ),
    move: (moves) =>
      changed((next) => {
        for (const { from, track } of moves) {
          next.delete(from);
          next.set(track.path, kept(track));
        }
      }).pipe(
        Effect.andThen(record({ moved: moves })),
        Effect.as({ moved: moves.length, released: [] }),
      ),
    missing: (paths) =>
      changed((next) => {
        for (const path of paths) {
          const row = next.get(path);

          if (row !== undefined)
            next.set(path, { track: row.track, missing: true, lyrics: row.lyrics });
        }
      }).pipe(Effect.andThen(record({ missing: paths })), Effect.as([])),
    lyrics: (tracks: ReadonlyArray<ScannedLyrics>) =>
      changed((next) => {
        for (const { path, lyricsFiles, lyricsReader, lyrics } of tracks) {
          const row = next.get(path);

          if (row !== undefined) {
            next.set(path, {
              track: row.track,
              missing: row.missing,
              lyrics: { lyricsFiles, lyricsReader, lyrics },
            });
          }
        }
      }).pipe(Effect.andThen(record({ lyrics: tracks.map((track) => track.path) }))),
  };

  return {
    catalog,
    tracks: Ref.get(rows),
    writes: Ref.getAndSet(sent, NO_WRITES),
  } satisfies MemoryCatalog;
});
