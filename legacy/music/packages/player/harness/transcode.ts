/**
 * The media service's real transcoder, for the media stub: fragmented profiles come out of the
 * exact ffmpeg pipeline and timing measurement production uses, cached under the fixtures folder.
 */
import { join } from "node:path";

import { TrackId } from "@music/commands/ids";
import { MediaConfig } from "@music/media/media-config";
import * as Transcoder from "@music/media/transcoder";
import { Duration, Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";

import { fixturesDir } from "./config.ts";

/** A finished transcode and the timing headers to send with it. */
export interface TranscodedFile {
  readonly path: string;
  readonly timing: {
    readonly priming: number;
    readonly duration: number;
    readonly sampleRate: number;
  } | null;
}

const config = Layer.succeed(
  MediaConfig,
  MediaConfig.of({
    convexUrl: "http://127.0.0.1:9",
    serviceSecret: Redacted.make("unused"),
    signingKey: Redacted.make("unused"),
    dataDir: join(fixturesDir, ".media-data"),
    port: 0,
    cacheMaxBytes: 1024 * 1024 * 1024,
    rescanInterval: Duration.hours(1),
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
  }),
);

const runtime = ManagedRuntime.make(Transcoder.layer.pipe(Layer.provide(config)));

/** Transcodes `source` (identified by `key`) to `profile`, reusing earlier output. */
export const transcode = (
  key: string,
  source: string,
  profile: "aac-320" | "aac-128" | "fmp4-flac" | "fmp4-aac",
  codec: string,
  mtimeMs: number,
): Promise<TranscodedFile> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const transcoder = yield* Transcoder.Transcoder;
      // The transcoder only uses the ID in cache file names and logs.
      const trackId = TrackId.make(key);
      const output = yield* transcoder.transcode({ trackId, profile, source, mtimeMs, codec });

      return {
        path: output.path,
        timing: Option.match(output.timing, {
          onNone: () => null,
          onSome: (timing) => ({
            priming: timing.primingSamples,
            duration: timing.durationSamples,
            sampleRate: timing.sampleRate,
          }),
        }),
      };
    }),
  );
