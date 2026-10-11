/** Temporary folders, the generated fixture library, configuration, and ffprobe for tests. */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Duration, Effect, Layer, Redacted, Schema, type Scope } from "effect";
import { afterAll } from "vitest";

import { type FixtureAlbum, generateFixtureLibrary } from "../../scripts/generate-fixtures.ts";
import { runTool } from "../ffmpeg.ts";
import * as Files from "../files.ts";
import { MediaConfig } from "../media-config.ts";

/** The signing key test configurations use. */
export const TEST_SIGNING_KEY = "test-signing-key";

/** A fresh folder under the system temp folder, removed when the scope closes. */
export const temporaryDirectory = (
  label: string,
): Effect.Effect<string, Files.FileError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => join(tmpdir(), `music-media-${label}-${randomUUID()}`)).pipe(
      Effect.tap((path) => Files.makeDirectory(path)),
    ),
    (path) => Files.removePath(path).pipe(Effect.ignore),
  );

/** Test timeout for anything that builds the fixture library or runs ffmpeg. */
export const MEDIA_TEST_TIMEOUT = 60_000;

const templates = new Map<
  string,
  Promise<{ readonly root: string; readonly albums: ReadonlyArray<FixtureAlbum> }>
>();

// Vitest isolates modules per test file, so each file generates its templates once and removes
// them when it finishes.
afterAll(async () => {
  const roots = await Promise.all(
    [...templates.values()].map(async (pending) => (await pending).root),
  );

  await Effect.runPromise(
    Effect.forEach(roots, (root) => Files.removePath(root).pipe(Effect.ignore)),
  );
});

/**
 * Generates each fixture variant once per test file, so the tests in a file do not each start a
 * dozen ffmpeg processes; every test then works on its own copy.
 */
const template = (albumSuffix: string) => {
  let pending = templates.get(albumSuffix);

  if (pending === undefined) {
    const root = join(tmpdir(), `music-media-template-${randomUUID()}`);

    pending = generateFixtureLibrary(root, albumSuffix).then((albums) => ({ root, albums }));
    templates.set(albumSuffix, pending);
  }

  return pending;
};

/** A private copy of the generated fixture library in a temporary folder, with what it contains. */
export const fixtureLibraryWith = (
  albumSuffix: string,
): Effect.Effect<
  { readonly root: string; readonly albums: ReadonlyArray<FixtureAlbum> },
  Files.FileError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const source = yield* Effect.promise(() => template(albumSuffix));
    const root = yield* temporaryDirectory("library");

    yield* Files.copyTree(source.root, root);

    return { root, albums: source.albums };
  });

/** The generated fixture library with its plain album titles. */
export const fixtureLibrary = fixtureLibraryWith("");

/** `MediaConfig` for tests, rooted at `dataDir`. */
export const testConfig = (
  dataDir: string,
  cacheMaxBytes = 512 * 1024 * 1024,
): Layer.Layer<MediaConfig> =>
  Layer.succeed(
    MediaConfig,
    MediaConfig.of({
      convexUrl: "http://127.0.0.1:9",
      serviceSecret: Redacted.make("test-service-secret"),
      signingKey: Redacted.make(TEST_SIGNING_KEY),
      dataDir,
      port: 0,
      cacheMaxBytes,
      rescanInterval: Duration.hours(1),
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
    }),
  );

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

const decodeProbe = Schema.decodeEffect(Schema.fromJsonString(Probe));

/** Reads a media file with ffprobe; fails when ffprobe cannot parse it. */
export const probe = Effect.fn("Test.probe")(function* (path: string) {
  const result = yield* runTool("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name,sample_rate,channels:format=format_name,duration",
    "-of",
    "json",
    path,
  ]);

  return yield* decodeProbe(result.stdout);
});
