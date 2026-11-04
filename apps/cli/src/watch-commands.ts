import { commands } from "@media/contracts/commands";
import { NotFound } from "@media/contracts/errors";
import { EpisodeId, TitleId } from "@media/contracts/ids";
import type { ProfileId } from "@media/contracts/ids";
import { type ClientCapabilities, PlaybackApiError } from "@media/contracts/media-playback";
import type { MediaVersion, TitleCard, TitleDetail } from "@media/contracts/models/catalog";
import { MoviesClient, Playback, Versions } from "@media/sdk/effect";
import { Effect, Option, Predicate, Result, Schema } from "effect";

import { LaunchError, PlaybackRefused } from "./cli-errors";
import { runAttached } from "./files";
import type { ShortcutCommand } from "./invocation";
import {
  booleanFlag,
  encodeResult,
  positionalText,
  positionFlag,
  requirePositional,
  resultOutcome,
  stringFlag,
  textOutcome,
  usage,
  viewingProfile,
} from "./invocation";
import { episodeLabel, formatDuration } from "./render";
import type { Connection } from "./session";
import { connect } from "./session";

const normalize = (text: string): string =>
  text
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * The version `choice` names among `versions`, in `titles.versions` order: a position counted
 * from 1, else a version name ignoring case, spaces, and punctuation, exactly or by its start.
 */
export const pickVersion = (
  choice: string,
  versions: ReadonlyArray<MediaVersion>,
): Option.Option<MediaVersion> => {
  if (/^\d+$/u.test(choice)) return Option.fromNullishOr(versions[Number(choice) - 1]);

  const wanted = squash(choice);
  const named = (version: MediaVersion) => squash(version.versionName ?? "");

  if (wanted === "") return Option.none();

  return Option.fromNullishOr(
    versions.find((version) => named(version) === wanted) ??
      versions.find((version) => named(version).startsWith(wanted)),
  );
};

const squash = (text: string): string => normalize(text).replaceAll(" ", "");

const CONVEX_ID = /^[a-z0-9]{32}$/u;

/** The best match for `query`: an exact name, then a name starting with it, then the first result. */
export const bestTitle = (
  query: string,
  results: ReadonlyArray<TitleCard>,
): Option.Option<TitleCard> => {
  const wanted = normalize(query);

  return Option.fromNullishOr(
    results.find((title) => normalize(title.name) === wanted) ??
      results.find((title) => normalize(title.name).startsWith(wanted)) ??
      results[0],
  );
};

const titleById = Effect.fn("Watch.titleById")(function* (
  connection: Connection,
  profileId: ProfileId,
  query: string,
) {
  if (!CONVEX_ID.test(query)) return Option.none<TitleDetail>();

  return yield* connection
    .withSession(connection.client.query("titles.get", { profileId, titleId: TitleId.make(query) }))
    .pipe(
      Effect.asSome,
      Effect.catchTags({
        NotFound: () => Effect.succeedNone,
        InvalidArgs: () => Effect.succeedNone,
      }),
    );
});

const searchTitle = Effect.fn("Watch.searchTitle")(function* (
  connection: Connection,
  profileId: ProfileId,
  query: string,
) {
  const results = yield* connection.withSession(
    connection.client.query("titles.search", { profileId, query, limit: 20 }),
  );

  const found = bestTitle(query, results);

  if (Option.isNone(found)) return yield* new NotFound({ message: `Nothing matches "${query}"` });

  return found.value;
});

/** Finds a title by ID or by searching its name on the profile. */
export const findTitle = Effect.fn("Watch.findTitle")(function* (
  connection: Connection,
  profileId: ProfileId,
  query: string,
) {
  const byId = yield* titleById(connection, profileId, query);

  return Option.isSome(byId) ? byId.value : yield* searchTitle(connection, profileId, query);
});

const findTitleDetail = Effect.fn("Watch.findTitleDetail")(function* (
  connection: Connection,
  profileId: ProfileId,
  query: string,
) {
  const byId = yield* titleById(connection, profileId, query);

  if (Option.isSome(byId)) return byId.value;
  const title = yield* searchTitle(connection, profileId, query);

  return yield* connection.withSession(
    connection.client.query("titles.get", { profileId, titleId: title.id }),
  );
});

const DESKTOP_PLAYER: ClientCapabilities = {
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

const search: ShortcutCommand = {
  path: "search",
  options: { limit: { type: "string" }, "profile-id": { type: "string" } },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const query = yield* requirePositional(invocation, "a search query");
      const limit = Option.map(stringFlag(invocation.tokens, "limit"), Number);

      if (
        Option.isSome(limit) &&
        !(Number.isInteger(limit.value) && limit.value >= 1 && limit.value <= 50)
      ) {
        return yield* usage(invocation, "--limit expects a whole number from 1 to 50");
      }

      const connection = yield* connect(invocation.env, invocation.target, "required");
      const profileId = yield* viewingProfile(invocation, connection.viewingProfileId);

      const results = yield* connection.withSession(
        connection.client.query("titles.search", {
          profileId,
          query,
          ...Option.match(limit, { onNone: () => ({}), onSome: (value) => ({ limit: value }) }),
        }),
      );

      const command = commands["titles.search"];

      return resultOutcome(command, yield* encodeResult("titles.search", command, results));
    }),
};

const play: ShortcutCommand = {
  path: "play",
  options: {
    "episode-id": { type: "string" },
    from: { type: "string" },
    "max-height": { type: "string" },
    open: { type: "boolean" },
    "profile-id": { type: "string" },
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

      const connection = yield* connect(invocation.env, invocation.target, "required");
      const profileId = yield* viewingProfile(invocation, connection.viewingProfileId);
      const title = yield* findTitle(connection, profileId, query);

      const flagEpisode = Option.map(stringFlag(invocation.tokens, "episode-id"), (id) =>
        EpisodeId.make(id),
      );

      const episode =
        title.kind === "movie" || Option.isSome(flagEpisode)
          ? Option.map(flagEpisode, (id) => ({ id, label: id }))
          : yield* Effect.gen(function* () {
              const detail = yield* connection.withSession(
                connection.client.query("titles.get", { profileId, titleId: title.id }),
              );

              if (detail.nextEpisode === null) {
                return yield* new NotFound({
                  message: `${title.name} has no episode to play next; pass --episode-id`,
                });
              }

              const next = detail.nextEpisode;

              return Option.some({
                id: next.id,
                label: episodeLabel(next),
              });
            });

      const fileId = yield* Option.match(versionChoice, {
        onNone: () => Effect.succeedNone,
        onSome: (choice) =>
          Effect.gen(function* () {
            const versions = yield* connection.withSession(
              connection.client.query("titles.versions", {
                profileId,
                titleId: title.id,
                ...Option.match(episode, {
                  onNone: () => ({}),
                  onSome: (chosen) => ({ episodeId: chosen.id }),
                }),
              }),
            );

            const picked = pickVersion(choice, versions);

            if (Option.isNone(picked)) {
              const listed = versions
                .map((version, index) => `${String(index + 1)}. ${Versions.label(version)}`)
                .join(", ");

              return yield* new NotFound({
                message: `${title.name} has no version "${choice}"; it has ${listed === "" ? "none on disk" : listed}`,
              });
            }

            return Option.some(picked.value.id);
          }),
      });

      const outcome = yield* connection.withSession(
        Playback.start({
          profileId,
          deviceId: connection.deviceId,
          deviceName: Option.some("media CLI"),
          titleId: title.id,
          episodeId: Option.map(episode, (chosen) => chosen.id),
          fileId,
          roomId: Option.none(),
          capabilities: DESKTOP_PLAYER,
          startAtMs: from,
          audioStreamIndex: Option.none(),
          quality: Option.map(maxHeight, (height) => ({ maxHeight: height })),
        }).pipe(
          Effect.provideService(MoviesClient.MoviesClient, connection.client),
          Effect.map(Result.succeed),
          Effect.catchIf(Schema.is(PlaybackApiError), (error) =>
            Effect.succeed(Result.fail(error)),
          ),
        ),
      );

      if (Result.isFailure(outcome)) {
        return yield* new PlaybackRefused({
          error: outcome.failure,
          recovery: Playback.recoveryFor(outcome.failure),
        });
      }

      const playback = outcome.success;

      const json = {
        sessionId: playback.started.sessionId,
        title: title.name,
        titleId: title.id,
        episode: Option.getOrNull(Option.map(episode, (chosen) => chosen.label)),
        fileId: playback.started.file.id,
        version: playback.started.file.versionName,
        mode: playback.stream.mode,
        url: playback.stream.url,
        startSeconds: playback.stream.startSeconds,
        durationSeconds: playback.stream.durationSeconds,
        expiresAt: playback.stream.expiresAt,
      };

      if (booleanFlag(invocation.tokens, "open")) {
        const args = [
          `--start=${String(playback.stream.startSeconds)}`,
          `--force-media-title=${title.name}`,
          playback.stream.url,
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
          `${title.name}${Option.match(episode, { onNone: () => "", onSome: (chosen) => ` ${chosen.label}` })}${playback.started.file.versionName === null ? "" : ` · ${playback.started.file.versionName}`} (${playback.stream.mode}, from ${formatDuration(playback.stream.startSeconds * 1000)})`,
          playback.stream.url,
        ].join("\n"),
      );
    }),
};

const progress: ShortcutCommand = {
  path: "progress",
  options: { "profile-id": { type: "string" } },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const profileId = yield* viewingProfile(invocation, connection.viewingProfileId);
      const query = positionalText(invocation.tokens);

      if (Option.isNone(query)) {
        const history = yield* connection.withSession(
          connection.client.query("history.list", { profileId, limit: 20 }),
        );

        const command = commands["history.list"];

        return resultOutcome(command, yield* encodeResult("history.list", command, history));
      }

      const detail = yield* findTitleDetail(connection, profileId, query.value);

      const json = {
        titleId: detail.id,
        name: detail.name,
        progress:
          detail.progress === null
            ? null
            : {
                positionMs: detail.progress.positionMs,
                durationMs: detail.progress.durationMs,
                watched: detail.progress.watched,
              },
        nextEpisode:
          detail.nextEpisode === null
            ? null
            : {
                id: detail.nextEpisode.id,
                seasonNumber: detail.nextEpisode.seasonNumber,
                episodeNumber: detail.nextEpisode.episodeNumber,
                name: detail.nextEpisode.name,
              },
      };

      const line =
        detail.progress !== null
          ? `${detail.name}: ${formatDuration(detail.progress.positionMs)} of ${formatDuration(detail.progress.durationMs)}${detail.progress.watched ? " (watched)" : ""}`
          : detail.nextEpisode !== null
            ? `${detail.name}: next ${episodeLabel(detail.nextEpisode)}`
            : `${detail.name}: not started`;

      return textOutcome(json, line);
    }),
};

const continueWatching: ShortcutCommand = {
  path: "continue",
  options: { "profile-id": { type: "string" } },
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const profileId = yield* viewingProfile(invocation, connection.viewingProfileId);

      const items = yield* connection.withSession(
        connection.client.query("history.continueWatching", { profileId }),
      );

      const command = commands["history.continueWatching"];

      return resultOutcome(
        command,
        yield* encodeResult("history.continueWatching", command, items),
      );
    }),
};

/** The watching shortcuts. */
export const watchCommands: ReadonlyArray<ShortcutCommand> = [
  search,
  play,
  progress,
  continueWatching,
];
