import { dynamicRangeOf, playsDirectly } from "@media/contracts/direct-play";
import type { DirectPlayFile } from "@media/contracts/direct-play";

import type { Handlers as HistoryHandlers } from "../../commands/movies/history";
import type { Handlers as PlayHandlers } from "../../commands/movies/play";
import type { Handlers as TitleHandlers } from "../../commands/movies/titles";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { currentManifest } from "./trickplayState";

type Result<H> = H extends (...args: never) => infer Answer ? Awaited<Answer> : never;

/** A title in a row or a list, as the movies commands answer it. */
export type TitleCard = Result<TitleHandlers["search"]>[number];

/** A title's page, as `movies.titles.get` answers it. */
export type TitleDetail = Result<TitleHandlers["get"]>;

/** An episode with the caller's progress through it. */
export type Episode = NonNullable<Result<TitleHandlers["nextEpisode"]>>;

/** A version of a movie or an episode to choose. */
export type MediaVersion = Result<TitleHandlers["versions"]>[number];

/** A file on disk as a player sees it, without its path. */
export type MediaFile = TitleDetail["files"][number];

/** A person's progress through one item. */
export type Progress = NonNullable<TitleDetail["progress"]>;

/** One credit with its person's name and photo. */
export type Credit = TitleDetail["cast"][number];

/** One item of continue watching. */
export type ContinueItem = Result<HistoryHandlers["continueWatching"]>[number];

/** What a device plays directly, as `movies.play.start` receives it. */
export type Capabilities = NonNullable<Parameters<PlayHandlers["start"]>[1]["capabilities"]>;

/** The minimum viewer age a title asks for: an admin's over the scanned one; null is unrated. */
export const ageRatingOf = (title: Doc<"titles">): number | null =>
  title.overrides?.ageRating ?? title.ageRating;

/** A title in a row, with an admin's edits applied. */
export const presentTitleCard = (title: Doc<"titles">): TitleCard => ({
  id: title._id,
  kind: title.kind,
  name: title.overrides?.name ?? title.name,
  year: title.overrides?.year ?? title.year,
  certification: title.overrides?.certification ?? title.certification,
  ageRating: ageRatingOf(title),
  runtimeMs: title.runtimeMs,
  genres: title.genres,
  artwork: title.artwork,
  available: title.presentFileCount > 0,
  addedAt: title.addedAt,
});

/** A file on disk without its path. */
export const presentMediaFile = (file: Doc<"mediaFiles">): MediaFile => ({
  id: file._id,
  titleId: file.titleId,
  episodeId: file.episodeId,
  versionName: file.versionName,
  sizeBytes: file.sizeBytes,
  probe: file.probe,
  externalSubtitles: file.externalSubtitles,
  hdr: file.hdr,
  trickplay: currentManifest(file),
});

const defaultAudio = (file: Doc<"mediaFiles">) =>
  file.probe.audio.find((track) => track.default) ?? file.probe.audio[0];

/** A file on disk as a version to choose, `lastPlayed` when the caller's progress names it. */
export const presentVersion = (
  file: Doc<"mediaFiles">,
  lastPlayedId: Id<"mediaFiles"> | null,
): MediaVersion => {
  const video = file.probe.video[0];
  const audio = defaultAudio(file);

  return {
    id: file._id,
    versionName: file.versionName,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hdr: video?.hdr ?? "none",
    videoCodec: video?.codec ?? null,
    videoProfile: video?.profile ?? null,
    videoLevel: video?.level ?? null,
    videoBitDepth: video?.bitDepth ?? null,
    audioCodec: audio?.codec ?? null,
    audioChannels: audio?.channels ?? null,
    audioTracks: file.probe.audio.length,
    container: file.probe.container,
    sizeBytes: file.sizeBytes,
    durationMs: file.probe.durationMs,
    lastPlayed: file._id === lastPlayedId,
  };
};

/** A person's progress through one item. */
export const presentProgress = (row: Doc<"watchProgress">): Progress => ({
  positionMs: row.positionMs,
  durationMs: row.durationMs,
  watched: row.watched,
  updatedAt: row.updatedAt,
});

/** An episode with the caller's progress through it. */
export const presentEpisode = (
  episode: Doc<"episodes">,
  watch: Doc<"watchProgress"> | null,
): Episode => ({
  id: episode._id,
  titleId: episode.titleId,
  seasonId: episode.seasonId,
  seasonNumber: episode.seasonNumber,
  episodeNumber: episode.episodeNumber,
  name: episode.name,
  overview: episode.overview,
  airDate: episode.airDate,
  runtimeMs: episode.runtimeMs,
  still: episode.still,
  rating: episode.rating?.value ?? null,
  externalIds: episode.externalIds,
  available: episode.presentFileCount > 0,
  progress: watch === null ? null : presentProgress(watch),
});

/**
 * Each group of credits with its people's names and photos, reading each person once across all
 * groups. People removed meanwhile are left out.
 */
export const presentCreditGroups = async (
  db: DatabaseReader,
  groups: ReadonlyArray<ReadonlyArray<Doc<"credits">>>,
): Promise<ReadonlyArray<ReadonlyArray<Credit>>> => {
  const ids = [...new Set(groups.flat().map((row) => row.personId))];
  const found = await Promise.all(ids.map(async (personId) => db.get(personId)));
  const people = new Map(ids.map((personId, index) => [personId, found[index] ?? null]));

  return groups.map((rows) =>
    rows.flatMap((row) => {
      const person = people.get(row.personId) ?? null;

      return person === null
        ? []
        : [
            {
              personId: person._id,
              name: person.name,
              kind: row.kind,
              role: row.role,
              profile: person.profile,
              order: row.order,
            },
          ];
    }),
  );
};

const primaryVideo = (file: Doc<"mediaFiles">) => file.probe.video[0];

const byQuality = (left: Doc<"mediaFiles">, right: Doc<"mediaFiles">): number =>
  (primaryVideo(right)?.height ?? 0) - (primaryVideo(left)?.height ?? 0) ||
  Number(right.hdr) - Number(left.hdr) ||
  (right.probe.bitRate ?? 0) - (left.probe.bitRate ?? 0) ||
  right.sizeBytes - left.sizeBytes ||
  left._creationTime - right._creationTime;

/** The files of `files` on disk that play `episodeId` (null for a movie), best quality first. */
export const onDiskBestFirst = (
  files: ReadonlyArray<Doc<"mediaFiles">>,
  episodeId: Id<"episodes"> | null,
): ReadonlyArray<Doc<"mediaFiles">> =>
  files.filter((file) => !file.missing && file.episodeId === episodeId).toSorted(byQuality);

/** Most files one movie or episode is read with: far above any real set of versions. */
const FILES_PER_ITEM_MAX = 100;

/** A movie's (`episode` null) or an episode's files on disk, best quality first. */
export const filesOnDisk = async (
  db: DatabaseReader,
  title: Doc<"titles">,
  episode: Doc<"episodes"> | null,
): Promise<ReadonlyArray<Doc<"mediaFiles">>> => {
  const files =
    episode === null
      ? await db
          .query("mediaFiles")
          .withIndex("by_title", (q) => q.eq("titleId", title._id))
          .take(FILES_PER_ITEM_MAX)
      : await db
          .query("mediaFiles")
          .withIndex("by_episode", (q) => q.eq("episodeId", episode._id))
          .take(FILES_PER_ITEM_MAX);

  return onDiskBestFirst(files, episode?._id ?? null);
};

/**
 * The episode `episodeId` names, for a show, or null for a movie. A show needs an episode, and an
 * episode of another show fails `not_found`.
 */
export const resolveEpisode = async (
  db: DatabaseReader,
  title: Doc<"titles">,
  episodeId: Id<"episodes"> | null,
): Promise<Doc<"episodes"> | null> => {
  if (title.kind === "movie") return null;

  if (episodeId === null) return fail("invalid_args", "Pick an episode");

  const episode = await db.get(episodeId);

  return episode?.titleId === title._id ? episode : fail("not_found", "No such episode");
};

/** A stored file as direct play reads it: its primary video and default audio track. */
const directPlayFile = (file: Doc<"mediaFiles">): DirectPlayFile => {
  const video = primaryVideo(file);
  const audio = defaultAudio(file);

  return {
    container: file.probe.container,
    video:
      video === undefined
        ? undefined
        : {
            codec: video.codec,
            profile: video.profile ?? undefined,
            level: video.level,
            bitDepth: video.bitDepth ?? 8,
            width: video.width,
            height: video.height,
            dynamicRange: dynamicRangeOf(video.hdr),
          },
    audio: audio === undefined ? undefined : { codec: audio.codec, channels: audio.channels },
  };
};

/** What picks a file when none is asked for, after the one the caller last played. */
export interface FilePreference {
  /** The file the caller's progress names, preferred while it is on disk. */
  readonly lastPlayed: Id<"mediaFiles"> | null;
  /** The device, whose best direct-play file comes next; null skips that step. */
  readonly client: Capabilities | null;
}

/**
 * The file that plays a movie (`episode` null) or an episode: the one asked for, else the one
 * last played while it is on disk, else the best the device plays directly, else the best
 * quality. A file of another title or episode, or one a scan marked missing, fails `not_found`;
 * a title with no file on disk fails `conflict`.
 */
export const choosePlayableFile = async (
  db: DatabaseReader,
  title: Doc<"titles">,
  episode: Doc<"episodes"> | null,
  fileId: Id<"mediaFiles"> | null,
  preference: FilePreference,
): Promise<Doc<"mediaFiles">> => {
  if (fileId !== null) {
    const file = await db.get(fileId);

    return file === null ||
      file.missing ||
      file.titleId !== title._id ||
      file.episodeId !== (episode?._id ?? null)
      ? fail("not_found", "No such file for this title")
      : file;
  }

  const files = await filesOnDisk(db, title, episode);
  const { client, lastPlayed } = preference;

  const chosen =
    files.find((candidate) => candidate._id === lastPlayed) ??
    (client === null
      ? undefined
      : files.find((candidate) => playsDirectly(client, directPlayFile(candidate)))) ??
    files[0];

  return chosen ?? fail("conflict", "This title's files are missing from disk");
};
