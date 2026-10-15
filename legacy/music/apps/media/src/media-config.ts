/** Runtime configuration of the media service, read once from the environment at startup. */
import { isAbsolute, resolve } from "node:path";

import { Config, Context, Duration, Effect, Layer, type Redacted, Schema } from "effect";

/** Typed media service settings. */
export interface Interface {
  /** Convex deployment URL, for example `http://127.0.0.1:3210`. */
  readonly convexUrl: string;
  /** Shared secret every `media:*` Convex function checks. */
  readonly serviceSecret: Redacted.Redacted;
  /** HMAC key Convex signs stream and art URLs with. */
  readonly signingKey: Redacted.Redacted;
  /** Absolute folder holding `art/` and the transcode `cache/`. */
  readonly dataDir: string;
  readonly port: number;
  /** Upper bound on the transcode cache before least recently used files are evicted. */
  readonly cacheMaxBytes: number;
  /** Interval of the periodic rescan that covers file systems without change events. */
  readonly rescanInterval: Duration.Duration;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  /**
   * The folders libraries may be in (`MUSIC_ROOTS`, comma-separated absolute paths): a library
   * whose real folder is elsewhere is not scanned. Null allows every folder outside /proc, /sys,
   * and /dev, as in development; the container image sets `/music`.
   */
  readonly musicRoots: ReadonlyArray<string> | null;
}

/** The media service configuration. */
export class MediaConfig extends Context.Service<MediaConfig, Interface>()(
  "@music/media/MediaConfig",
) {}

const MEGABYTE = 1024 * 1024;

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** Reads `MediaConfig` from environment variables. */
export const layer: Layer.Layer<MediaConfig, Config.ConfigError> = Layer.effect(
  MediaConfig,
  Effect.gen(function* () {
    const convexUrl = yield* Config.URL("CONVEX_URL");
    const serviceSecret = yield* Config.Redacted("MEDIA_SERVICE_SECRET");
    const signingKey = yield* Config.Redacted("STREAM_SIGNING_KEY");
    const dataDir = yield* Config.NonEmptyString("MEDIA_DATA_DIR");
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(4100));

    const cacheMaxMb = yield* Config.schema(PositiveInt, "MEDIA_CACHE_MAX_MB").pipe(
      Config.withDefault(2048),
    );

    const rescanMinutes = yield* Config.schema(PositiveInt, "MEDIA_RESCAN_MINUTES").pipe(
      Config.withDefault(60),
    );

    const ffmpegPath = yield* Config.NonEmptyString("FFMPEG_PATH").pipe(
      Config.withDefault("ffmpeg"),
    );

    const ffprobePath = yield* Config.NonEmptyString("FFPROBE_PATH").pipe(
      Config.withDefault("ffprobe"),
    );

    const roots = yield* Config.String("MUSIC_ROOTS").pipe(Config.withDefault(""));

    const musicRoots = roots
      .split(",")
      .map((root) => root.trim())
      .filter((root) => root.length > 0)
      .map((root) => resolve(root));

    return MediaConfig.of({
      convexUrl: convexUrl.origin + convexUrl.pathname.replace(/\/+$/, ""),
      serviceSecret,
      signingKey,
      dataDir: isAbsolute(dataDir) ? dataDir : resolve(dataDir),
      port,
      cacheMaxBytes: cacheMaxMb * MEGABYTE,
      rescanInterval: Duration.minutes(rescanMinutes),
      ffmpegPath,
      ffprobePath,
      musicRoots: musicRoots.length === 0 ? null : musicRoots,
    });
  }),
);
