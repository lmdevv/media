/**
 * The media service's real transcoder and stream responses, for the media stub: transcoded
 * profiles come out of the exact ffmpeg pipeline, timing measurement, and live streaming
 * production uses, cached under the fixtures folder.
 */
import { join } from "node:path";

import { TrackId } from "@music/commands/ids";
import { MediaConfig } from "@music/media/media-config";
import { offsetResponse, transcodedResponse } from "@music/media/transcoded-response";
import * as Transcoder from "@music/media/transcoder";
import { Duration, Layer, ManagedRuntime, Redacted } from "effect";

import { fixturesDir } from "./config.ts";

/** Where the stub's transcodes go. */
const dataDir = join(fixturesDir, ".media-data");

const config = Layer.succeed(
  MediaConfig,
  MediaConfig.of({
    convexUrl: "http://127.0.0.1:9",
    serviceSecret: Redacted.make("unused"),
    signingKey: Redacted.make("unused"),
    dataDir,
    port: 0,
    cacheMaxBytes: 1024 * 1024 * 1024,
    rescanInterval: Duration.hours(1),
    // ffmpeg itself, slowed down while the stub's `slow` control is on.
    ffmpegPath: join(import.meta.dirname, "throttled-ffmpeg.sh"),
    ffprobePath: "ffprobe",
    musicRoots: null,
  }),
);

const runtime = ManagedRuntime.make(Transcoder.layer.pipe(Layer.provide(config)));

/**
 * Answers `request` with `source` (identified by `key`) transcoded to `profile`, exactly as the
 * media service does: from the cache, live while a transcode is being written, or from the
 * request's `start` offset. Rejects when the transcode fails before its first byte.
 */
export const transcodedStream = (
  request: Request,
  key: string,
  source: string,
  profile: "aac-320" | "aac-128" | "fmp4-flac" | "fmp4-aac",
  codec: string,
  mtimeMs: number,
): Promise<Response> => {
  // The transcoder only uses the ID in cache file names and logs.
  const input = { trackId: TrackId.make(key), profile, source, mtimeMs, codec };
  const startMs = Number(new URL(request.url).searchParams.get("start") ?? "0");

  return startMs > 0
    ? runtime.runPromise(offsetResponse(request, input, startMs))
    : runtime.runPromise(transcodedResponse(request, input));
};

/**
 * Added to every source's modification time in cache keys. `POST /control/cold` moves it to a
 * value no earlier transcode used, in this run or a previous one, so the next request for each
 * source misses the cache and streams live.
 */
let generation = 0;

/** Makes every later request miss the transcodes cached so far. */
export const coldCache = (): void => {
  generation = Date.now();
};

/** The modification time to key `mtimeMs` by in the cache, after `coldCache` calls. */
export const cacheTime = (mtimeMs: number): number => Math.trunc(mtimeMs) + generation;
