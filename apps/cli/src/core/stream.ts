import { NotFound } from "@media/contracts/errors";
import { type ClientCapabilities, PlaybackApiError } from "@media/contracts/media-playback";
import { StartedPlayback } from "@media/contracts/models/playback";
import type { Platform } from "@media/sdk/effect";
import { Playback, ProtocolError } from "@media/sdk/effect";
import { Brand, Effect, Option, Predicate, Result, Schema } from "effect";

import { LaunchError, PlaybackRefused } from "../cli-errors";
import type { Connection } from "../config";
import { connect } from "../config";
import { runAttached } from "../files";
import {
  booleanFlag,
  positionFlag,
  requirePositional,
  stringFlag,
  textOutcome,
  usage,
} from "../invocation";
import { episodeLabel, formatDuration } from "../render";
import type { CoreShortcut } from "./command";
import { coreShortcut } from "./command";

const normalize = (text: string): string =>
  text
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const squash = (text: string): string => normalize(text).replaceAll(" ", "");

/**
 * The version `choice` names among `versions`, in `movies.titles.versions` order: a position
 * counted from 1, else a version name ignoring case, spaces, and punctuation, exactly or by its
 * start.
 */
export const pickVersion = <Version extends { readonly versionName: string | null }>(
  choice: string,
  versions: ReadonlyArray<Version>,
): Option.Option<Version> => {
  if (/^\d+$/u.test(choice)) return Option.fromNullishOr(versions[Number(choice) - 1]);

  const wanted = squash(choice);
  const named = (version: Version) => squash(version.versionName ?? "");

  if (wanted === "") return Option.none();

  return Option.fromNullishOr(
    versions.find((version) => named(version) === wanted) ??
      versions.find((version) => named(version).startsWith(wanted)),
  );
};

/** The best match for `query`: an exact name, then a name starting with it, then the first result. */
export const bestTitle = <Title extends { readonly name: string }>(
  query: string,
  results: ReadonlyArray<Title>,
): Option.Option<Title> => {
  const wanted = normalize(query);

  return Option.fromNullishOr(
    results.find((title) => normalize(title.name) === wanted) ??
      results.find((title) => normalize(title.name).startsWith(wanted)) ??
      results[0],
  );
};

const CONVEX_ID = /^[a-z0-9]{32}$/u;

/** An ID typed on the command line; the core checks that it names a row of its table. */
const asTitleId = Brand.nominal<Platform.Id<"titles">>();

const asEpisodeId = Brand.nominal<Platform.Id<"episodes">>();

/** What `movies.play.start` takes as a player's capabilities. */
type StartCapabilities = NonNullable<
  Parameters<Platform.Interface["movies"]["play"]["start"]>[0]["capabilities"]
>;

/** A desktop player such as mpv or VLC: it plays every container and codec, direct or HLS. */
const DESKTOP_PLAYER: StartCapabilities & ClientCapabilities = {
  containers: ["mp4", "mov", "mkv", "webm", "avi", "ts", "other"],
  videoCodecs: ["h264", "hevc", "av1", "vp9", "vp8", "mpeg4", "mpeg2video", "vc1"].map((codec) => ({
    codec,
    maxBitDepth: 12,
    dynamicRanges: ["sdr", "hdr10", "hlg", "dolby-vision"],
  })),
  audioCodecs: [
    "aac",
    "ac3",
    "eac3",
    "dts",
    "truehd",
    "flac",
    "opus",
    "mp3",
    "mp2",
    "vorbis",
    "pcm_s16le",
  ].map((codec) => ({ codec, maxChannels: 8 })),
  maxWidth: 7680,
  maxHeight: 4320,
  hls: true,
  mse: false,
};

/** The title an ID names, or none when the text is no title ID the person may see. */
const titleById = (connection: Connection, query: string) =>
  CONVEX_ID.test(query)
    ? connection.platform.movies.titles.get({ titleId: asTitleId(query) }).pipe(
        Effect.asSome,
        Effect.catchTags({
          NotFound: () => Effect.succeedNone,
          InvalidArgs: () => Effect.succeedNone,
        }),
      )
    : Effect.succeedNone;

/** The title `query` names by its ID or as the best match of a search, with its details. */
const findTitle = Effect.fn("Stream.findTitle")(function* (connection: Connection, query: string) {
  const byId = yield* titleById(connection, query);

  if (Option.isSome(byId)) return byId.value;

  const results = yield* connection.platform.movies.titles.search({ query, limit: 20 });
  const found = bestTitle(query, results);

  if (Option.isNone(found)) return yield* new NotFound({ message: `Nothing matches "${query}"` });

  return yield* connection.platform.movies.titles.get({ titleId: found.value.id });
});

const decodeStarted = Schema.decodeUnknownEffect(StartedPlayback);

const isPlaybackApiError = Schema.is(PlaybackApiError);

const stream = coreShortcut("movies", "stream", {
  usage:
    "<title> [--episode-id <id>] [--version <name|number>] [--from <seconds>] [--max-height <lines>] [--open]",
  summary:
    "Start a title by its ID or the best name match (a show resumes its next episode) and print the stream URL for mpv or VLC; --version picks a file by its name or its number in `media movies titles versions` (default: the one you last played, else the best quality); --max-height caps the picture, such as 720 on a slow link (a taller source is transcoded down); --open launches mpv",
  options: {
    "episode-id": { type: "string" },
    from: { type: "string" },
    "max-height": { type: "string" },
    open: { type: "boolean" },
    version: { type: "string" },
  },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const query = yield* requirePositional(invocation, "a title name or ID");
      const from = yield* positionFlag(invocation, "from");
      const rawVersion = invocation.tokens.values["version"];

      const versionChoice = Predicate.isString(rawVersion)
        ? Option.some(rawVersion.trim())
        : Option.none();

      if (Option.contains(versionChoice, "")) {
        return yield* usage(
          invocation,
          "--version expects a version name or its number, such as 2",
        );
      }

      const maxHeight = Option.map(stringFlag(invocation.tokens, "max-height"), Number);

      if (
        Option.isSome(maxHeight) &&
        !(Number.isInteger(maxHeight.value) && maxHeight.value >= 144 && maxHeight.value <= 4320)
      ) {
        return yield* usage(invocation, "--max-height expects lines from 144 to 4320, such as 720");
      }

      const connection = yield* connect(invocation.target, "required");
      const { platform } = connection;
      const title = yield* connection.signedIn(findTitle(connection, query));

      const flagEpisode = Option.map(stringFlag(invocation.tokens, "episode-id"), (id) =>
        asEpisodeId(id),
      );

      const episodeId =
        title.kind === "movie" || Option.isSome(flagEpisode)
          ? flagEpisode
          : title.nextEpisode === null
            ? yield* new NotFound({
                message: `${title.name} has no episode to play next; pass --episode-id`,
              })
            : Option.some(title.nextEpisode.id);

      const fileId = yield* Option.match(versionChoice, {
        onNone: () => Effect.succeedNone,
        onSome: (choice) =>
          Effect.gen(function* () {
            const versions = yield* connection.signedIn(
              platform.movies.titles.versions({
                titleId: title.id,
                ...Option.match(episodeId, {
                  onNone: () => ({}),
                  onSome: (id) => ({ episodeId: id }),
                }),
              }),
            );

            const picked = pickVersion(choice, versions);

            if (Option.isNone(picked)) {
              const listed = versions
                .map(
                  (version, index) => `${String(index + 1)}. ${version.versionName ?? "unnamed"}`,
                )
                .join(", ");

              return yield* new NotFound({
                message: `${title.name} has no version "${choice}"; it has ${listed === "" ? "none on disk" : listed}`,
              });
            }

            return Option.some(picked.value.id);
          }),
      });

      const start = yield* connection.signedIn(
        platform.movies.play.start({
          titleId: title.id,
          ...Option.match(episodeId, { onNone: () => ({}), onSome: (id) => ({ episodeId: id }) }),
          ...Option.match(fileId, { onNone: () => ({}), onSome: (id) => ({ fileId: id }) }),
          capabilities: DESKTOP_PLAYER,
        }),
      );

      const started = yield* decodeStarted({
        sessionId: start.playbackId,
        titleId: start.titleId,
        episodeId: start.episodeId,
        episode: start.episode,
        file: { ...start.file, missing: false },
        token: start.ticket,
        tokenExpiresAt: start.expiresAt,
        mediaBaseUrl: connection.mediaUrl,
        resumePositionMs: start.resumePositionMs,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProtocolError({
              operation: "movies.play.start",
              message:
                "Protocol error in movies.play.start: the start does not describe a playable file",
              cause,
            }),
        ),
      );

      const negotiated = yield* Playback.negotiate(
        started,
        DESKTOP_PLAYER,
        Option.getOrElse(from, () => started.resumePositionMs),
        Option.none(),
        {
          quality: Option.map(maxHeight, (height) => ({ maxHeight: height })),
          burnInSubtitle: Option.none(),
        },
      ).pipe(
        Effect.map(Result.succeed),
        Effect.catchIf(isPlaybackApiError, (error) => Effect.succeed(Result.fail(error))),
      );

      if (Result.isFailure(negotiated)) {
        return yield* new PlaybackRefused({
          error: negotiated.failure,
          recovery: Playback.recoveryFor(negotiated.failure),
        });
      }

      const playback = negotiated.success;
      const episode = Option.fromNullishOr(started.episode).pipe(Option.map(episodeLabel));

      const json = {
        sessionId: start.playbackId,
        title: title.name,
        titleId: title.id,
        episode: Option.getOrNull(episode),
        fileId: started.file.id,
        version: started.file.versionName,
        mode: playback.mode,
        url: playback.url,
        startSeconds: playback.startSeconds,
        durationSeconds: playback.durationSeconds,
        expiresAt: playback.expiresAt,
      };

      if (booleanFlag(invocation.tokens, "open")) {
        const args = [
          `--start=${String(playback.startSeconds)}`,
          `--force-media-title=${title.name}`,
          playback.url,
        ];

        yield* Effect.tryPromise({
          try: () => runAttached("mpv", args),
          catch: (cause) =>
            new LaunchError({
              program: "mpv",
              message: "Could not start mpv; install it or play the printed URL in another player",
              cause,
            }),
        });
      }

      return textOutcome(
        json,
        [
          `${title.name}${Option.match(episode, { onNone: () => "", onSome: (label) => ` ${label}` })}${started.file.versionName === null ? "" : ` · ${started.file.versionName}`} (${playback.mode}, from ${formatDuration(playback.startSeconds * 1000)})`,
          playback.url,
        ].join("\n"),
      );
    }),
});

/** The hand-written commands of the `movies` group. */
export const moviesCommands: ReadonlyArray<CoreShortcut> = [stream];
