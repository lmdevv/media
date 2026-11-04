import type { ArtworkKey } from "@media/contracts/artwork";
import { ageRatingFromCertification } from "@media/contracts/content-rating";
import { dynamicRangeOf } from "@media/contracts/direct-play";
import { Container, type DynamicRange } from "@media/contracts/media-playback";
import type { ExternalSubtitle, HdrFormat, Probe } from "@media/contracts/models/catalog";
import { type Ratings, type Trailer, YOUTUBE_KEY_PATTERN } from "@media/contracts/models/catalog";
import {
  CREDIT_BATCH_LIMIT,
  type ResolvedFile,
  type ScannedCollection,
  type ScannedCredit,
  type ScannedEpisode,
  type ScannedItem,
  type ScannedTitle,
  TITLE_LIST_LIMIT,
  TITLE_TAG_LIMIT,
} from "@media/contracts/models/scan";
import { createHash } from "node:crypto";
import { Bytes, EpochMillis, Milliseconds } from "@media/contracts/units";
import { Effect, Option, Schema } from "effect";

import { ArtworkSource } from "../artwork/artwork-keys.ts";
import type { LibraryFolder, ScannedFile } from "../library/library-sink.ts";
import { SidecarFormat } from "../library/sidecar-subtitles.ts";
import { MediaName } from "../library/media-naming.ts";
import type { MediaProbe } from "../media/media-probe.ts";
import type { Score, SiteRatings } from "../library/nfo.ts";
import {
  type EpisodeMetadata,
  ImageRef,
  type MergedCollection,
  type MergedCredit,
  type TitleMetadata,
} from "../metadata/title-metadata.ts";
import type { ResolvedMediaFile } from "../playback/file-resolver.ts";

type SealArtwork = (source: ArtworkSource) => Effect.Effect<ArtworkKey>;

const HDR_FORMATS: Readonly<Record<DynamicRange, HdrFormat>> = {
  sdr: "none",
  hdr10: "hdr10",
  hlg: "hlg",
  "dolby-vision": "dolby_vision",
};

const present = <A>(value: A | undefined): Option.Option<A> => Option.fromUndefinedOr(value);

/** The absolute path of `relativePath` inside a library folder. */
export const absolutePath = (folder: LibraryFolder, relativePath: string): string =>
  `${folder.root.replace(/\/+$/u, "")}/${relativePath}`;

/** The path relative to `root` when `path` lies inside it. */
export const relativeTo = (root: string, path: string): Option.Option<string> => {
  const prefix = `${root.replace(/\/+$/u, "")}/`;

  return path.startsWith(prefix) ? Option.some(path.slice(prefix.length)) : Option.none();
};

const fileNameOf = (path: string): string => path.split("/").at(-1) ?? path;

const folderOf = (path: string): string => path.split("/").slice(0, -1).join("/");

/** The catalog probe of a scanned file. */
export const toCatalogProbe = (probe: MediaProbe): Probe => ({
  container: probe.container,
  formatName: probe.formatName,
  durationMs: Milliseconds.make(Math.round(probe.durationSeconds * 1000)),
  startMs: Math.round(probe.startSeconds * 1000),
  bitRate: probe.bitRate ?? null,
  video:
    probe.video === undefined
      ? []
      : [
          {
            index: probe.video.index,
            codec: probe.video.codec,
            profile: probe.video.profile ?? null,
            ...Option.match(present(probe.video.level), {
              onNone: () => ({}),
              onSome: (level) => ({ level }),
            }),
            width: probe.video.width,
            height: probe.video.height,
            frameRate: probe.video.frameRate ?? null,
            bitDepth: probe.video.bitDepth,
            pixelFormat: probe.video.pixelFormat ?? null,
            hdr: HDR_FORMATS[probe.video.dynamicRange],
            bitRate: null,
          },
        ],
  audio: probe.audio.map((track) => ({
    index: track.index,
    codec: track.codec,
    profile: track.profile ?? null,
    channels: track.channels,
    channelLayout: track.channelLayout ?? null,
    ...Option.match(present(track.sampleRate), {
      onNone: () => ({}),
      onSome: (sampleRate) => ({ sampleRate }),
    }),
    language: track.language ?? null,
    title: track.title ?? null,
    default: track.default,
    bitRate: null,
    ...Option.match(present(track.endSeconds), {
      onNone: () => ({}),
      onSome: (end) => ({ endMs: Math.round(end * 1000) }),
    }),
  })),
  subtitles: probe.subtitles.map((subtitle) => ({
    index: subtitle.index,
    codec: subtitle.codec,
    kind: subtitle.kind === "bitmap" ? ("image" as const) : ("text" as const),
    language: subtitle.language ?? null,
    title: subtitle.title ?? null,
    default: subtitle.default,
    forced: subtitle.forced,
    hearingImpaired: subtitle.hearingImpaired,
  })),
  chapters: probe.chapters.map((chapter) => ({
    startMs: Milliseconds.make(Math.round(chapter.startSeconds * 1000)),
    endMs: Milliseconds.make(Math.round(chapter.endSeconds * 1000)),
    title: chapter.title ?? null,
  })),
});

const decodeContainer = Schema.decodeUnknownOption(Container);

const decodeSidecarFormat = Schema.decodeUnknownOption(SidecarFormat);

const toMediaProbe = (probe: Probe): MediaProbe => {
  const [video] = probe.video;

  return {
    container: Option.getOrElse(decodeContainer(probe.container), () => "other" as const),
    formatName: probe.formatName ?? probe.container,
    durationSeconds: probe.durationMs / 1000,
    startSeconds: (probe.startMs ?? 0) / 1000,
    bitRate: probe.bitRate ?? undefined,
    video:
      video === undefined
        ? undefined
        : {
            index: video.index,
            codec: video.codec,
            profile: video.profile ?? undefined,
            level: video.level,
            pixelFormat: video.pixelFormat ?? undefined,
            bitDepth: video.bitDepth ?? 8,
            width: video.width,
            height: video.height,
            frameRate: video.frameRate ?? undefined,
            dynamicRange: dynamicRangeOf(video.hdr),
          },
    audio: probe.audio.map((track) => ({
      index: track.index,
      codec: track.codec,
      profile: track.profile ?? undefined,
      channels: track.channels,
      channelLayout: track.channelLayout ?? undefined,
      sampleRate: track.sampleRate,
      language: track.language ?? undefined,
      title: track.title ?? undefined,
      default: track.default,
      endSeconds: track.endMs === undefined ? undefined : track.endMs / 1000,
    })),
    subtitles: probe.subtitles.map((subtitle) => ({
      index: subtitle.index,
      codec: subtitle.codec,
      kind: subtitle.kind === "image" ? ("bitmap" as const) : ("text" as const),
      language: subtitle.language ?? undefined,
      title: subtitle.title ?? undefined,
      default: subtitle.default,
      forced: subtitle.forced,
      hearingImpaired: subtitle.hearingImpaired ?? false,
    })),
    chapters: (probe.chapters ?? []).map((chapter) => ({
      startSeconds: chapter.startMs / 1000,
      endSeconds: chapter.endMs / 1000,
      title: chapter.title ?? undefined,
    })),
  };
};

/** Everything playback needs about a catalog file. Sidecars of unknown formats are dropped. */
export const toResolvedMediaFile = (
  resolved: ResolvedFile,
  sizeBytes: number,
  modifiedAtMs: number,
): ResolvedMediaFile => {
  const folder = folderOf(resolved.path);

  return {
    fileId: resolved.fileId,
    path: resolved.path,
    sizeBytes,
    modifiedAtMs,
    probe: toMediaProbe(resolved.probe),
    subtitles: resolved.externalSubtitles.flatMap((subtitle) =>
      Option.match(decodeSidecarFormat(subtitle.codec), {
        onNone: () => [],
        onSome: (format) => [
          {
            path: `${folder}/${subtitle.fileName}`,
            format,
            language: subtitle.language ?? undefined,
            title: subtitle.title,
            forced: subtitle.forced,
            hearingImpaired: subtitle.hearingImpaired ?? false,
            default: subtitle.default ?? false,
          },
        ],
      }),
    ),
  };
};

const normaliseName = (name: string): string =>
  name.toLowerCase().replaceAll(/\s+/gu, " ").trim().slice(0, 200);

/**
 * The key that identifies a title within its library across scans: the kind plus a provider ID
 * when one is known (TMDB IDs of movies and shows overlap), otherwise the name and year.
 */
export const matchKeyOf = (metadata: TitleMetadata): string => {
  const { ids } = metadata;

  if (ids.tmdb !== undefined) return `${metadata.kind}:tmdb:${ids.tmdb}`;

  if (ids.imdb !== undefined) return `${metadata.kind}:imdb:${ids.imdb}`;

  if (ids.tvdb !== undefined) return `${metadata.kind}:tvdb:${ids.tvdb}`;

  const year = metadata.year === undefined ? "" : ` (${String(metadata.year)})`;

  return `${metadata.kind}:local:${normaliseName(metadata.title)}${year}`;
};

const artworkKey = (
  folder: LibraryFolder,
  image: ImageRef | undefined,
  seal: SealArtwork,
): Effect.Effect<ArtworkKey | null> =>
  image === undefined
    ? Effect.succeed(null)
    : seal(
        ImageRef.match(image, {
          Local: ({ path }): ArtworkSource =>
            ArtworkSource.Local({ path: absolutePath(folder, path) }),
          Remote: ({ url }): ArtworkSource => ArtworkSource.Remote({ url }),
        }),
      );

const communityRating = (score: Score | undefined) =>
  score === undefined
    ? null
    : { value: Math.min(10, Math.max(0, score.value)), votes: score.votes ?? null };

const percentScore = (value: number | undefined): number | null =>
  value === undefined ? null : Math.min(100, Math.max(0, Math.round(value)));

const toRatings = (ratings: SiteRatings): Ratings => ({
  tmdb: communityRating(ratings.tmdb),
  imdb: communityRating(ratings.imdb),
  rottenTomatoes: percentScore(ratings.rottenTomatoes),
  metacritic: percentScore(ratings.metacritic),
});

const toTrailer = (trailer: TitleMetadata["trailer"]): Trailer | null =>
  trailer === undefined || !YOUTUBE_KEY_PATTERN.test(trailer.key)
    ? null
    : { site: "youtube", key: trailer.key, name: trailer.name ?? null };

const distinct = (values: ReadonlyArray<string>, limit: number): Array<string> =>
  [
    ...new Set(
      values.flatMap((value) => {
        const trimmed = value.trim();

        return trimmed === "" ? [] : [trimmed];
      }),
    ),
  ].slice(0, limit);

/** Provider IDs as the catalog stores them: null where unknown. */
export const idsOrNull = (ids: TitleMetadata["ids"]) => ({
  tmdb: ids.tmdb ?? null,
  imdb: ids.imdb ?? null,
  tvdb: ids.tvdb ?? null,
});

/** The catalog title of merged title metadata. */
export const toScannedTitle = Effect.fnUntraced(function* (
  folder: LibraryFolder,
  metadata: TitleMetadata,
  seal: SealArtwork,
) {
  const certification = metadata.contentRating ?? null;
  const hasIds = Object.values(metadata.ids).some((id) => id !== undefined);

  return {
    kind: metadata.kind,
    matchKey: matchKeyOf(metadata),
    name: metadata.title,
    sortName: metadata.sortTitle ?? null,
    year: metadata.year ?? null,
    overview: metadata.plot ?? null,
    tagline: metadata.tagline ?? null,
    genres: metadata.genres,
    certification,
    ageRating: certification === null ? null : (ageRatingFromCertification(certification) ?? null),
    runtimeMs:
      metadata.runtimeMinutes === undefined
        ? null
        : Milliseconds.make(metadata.runtimeMinutes * 60_000),
    artwork: {
      poster: yield* artworkKey(folder, metadata.poster, seal),
      backdrop: yield* artworkKey(folder, metadata.backdrop, seal),
      logo: yield* artworkKey(folder, metadata.logo, seal),
    },
    externalIds: idsOrNull(metadata.ids),
    matchStatus: metadata.sources.includes("provider") || hasIds ? "matched" : "unmatched",
    originalName:
      metadata.originalTitle === undefined || metadata.originalTitle === metadata.title
        ? null
        : metadata.originalTitle,
    releaseDate: metadata.releaseDate ?? null,
    status: metadata.kind === "show" ? (metadata.status ?? null) : null,
    originalLanguage: metadata.originalLanguage ?? null,
    studios: distinct(metadata.studios, TITLE_LIST_LIMIT),
    countries: distinct(metadata.countries, TITLE_LIST_LIMIT),
    tags: distinct(metadata.tags, TITLE_TAG_LIMIT),
    ratings: toRatings(metadata.ratings),
    trailer: toTrailer(metadata.trailer),
    recommendations: distinct(metadata.recommendations, TITLE_LIST_LIMIT),
  } satisfies ScannedTitle;
});

/** The catalog episode of merged episode metadata. A multi-episode file maps to its first. */
export const toScannedEpisode = Effect.fnUntraced(function* (
  folder: LibraryFolder,
  metadata: EpisodeMetadata,
  seal: SealArtwork,
) {
  return {
    seasonNumber: metadata.season,
    episodeNumber: metadata.episodes[0],
    name: metadata.title ?? null,
    overview: metadata.plot ?? null,
    airDate: metadata.airDate ?? null,
    runtimeMs:
      metadata.runtimeMinutes === undefined
        ? null
        : Milliseconds.make(metadata.runtimeMinutes * 60_000),
    still: yield* artworkKey(folder, metadata.still, seal),
    seasonName: null,
    seasonPoster: yield* artworkKey(folder, metadata.seasonPoster, seal),
    rating: communityRating(metadata.rating),
    externalIds: idsOrNull(metadata.ids),
    seasonExternalIds: idsOrNull(metadata.seasonIds),
  } satisfies ScannedEpisode;
});

/** The catalog credits of merged credits, at most `CREDIT_BATCH_LIMIT`. */
export const toScannedCredits = Effect.fnUntraced(function* (
  folder: LibraryFolder,
  credits: ReadonlyArray<MergedCredit>,
  seal: SealArtwork,
) {
  return yield* Effect.forEach(
    credits.filter((credit) => credit.name.trim() !== "").slice(0, CREDIT_BATCH_LIMIT),
    (credit) =>
      Effect.map(artworkKey(folder, credit.profile, seal), (profile): ScannedCredit => ({
        person: { name: credit.name.trim(), externalIds: idsOrNull(credit.ids), profile },
        kind: credit.kind,
        role: credit.role ?? null,
        order: credit.order,
      })),
  );
});

/** The catalog collection of a merged collection. */
export const toScannedCollection = Effect.fnUntraced(function* (
  folder: LibraryFolder,
  collection: MergedCollection | undefined,
  seal: SealArtwork,
) {
  if (collection === undefined || collection.name.trim() === "") return null;

  return {
    sourceKey: collection.sourceKey,
    name: collection.name.trim(),
    overview: collection.overview ?? null,
    poster: yield* artworkKey(folder, collection.poster, seal),
    backdrop: yield* artworkKey(folder, collection.backdrop, seal),
  } satisfies ScannedCollection;
});

/** A digest of what a write would store, so unchanged rescans can skip it. */
export const digestOf = (value: ReadonlyArray<ScannedCredit> | ScannedCollection | null): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("base64url");

const toExternalSubtitle = (subtitle: ScannedFile["subtitles"][number]): ExternalSubtitle => ({
  fileName: fileNameOf(subtitle.path),
  codec: subtitle.format,
  language: subtitle.language ?? null,
  ...Option.match(present(subtitle.title), {
    onNone: () => ({}),
    onSome: (title) => ({ title }),
  }),
  forced: subtitle.forced,
  hearingImpaired: subtitle.hearingImpaired,
  default: subtitle.default,
});

/**
 * What tells a movie's file from its others in the version picker: its edition, its part of a
 * movie split across files, or both (`Director's Cut · Part 2`); null for episodes and plain
 * files.
 */
export const versionNameOf = (name: MediaName): string | null => {
  if (!MediaName.guards.Movie(name)) return null;

  const part = name.part === undefined ? undefined : `Part ${String(name.part)}`;
  const parts = [name.edition, part].filter((piece) => piece !== undefined);

  return parts.length === 0 ? null : parts.join(" · ");
};

/**
 * The catalog item of a scanned file, or none for an extra (a trailer or featurette), which
 * belongs to no title.
 */
export const toScannedItem = Effect.fnUntraced(function* (
  folder: LibraryFolder,
  file: ScannedFile,
  seal: SealArtwork,
) {
  if (file.title === undefined) return Option.none<ScannedItem>();

  const item: ScannedItem = {
    file: {
      path: absolutePath(folder, file.relativePath),
      sizeBytes: Bytes.make(file.sizeBytes),
      mtimeMs: EpochMillis.make(Math.trunc(file.modifiedAtMs)),
      probe: toCatalogProbe(file.probe),
      externalSubtitles: file.subtitles.map(toExternalSubtitle),
      versionName: versionNameOf(file.name),
      sidecarDigest: file.sidecarDigest,
    },
    title: yield* toScannedTitle(folder, file.title, seal),
    episode:
      file.episode === undefined ? null : yield* toScannedEpisode(folder, file.episode, seal),
  };

  return Option.some(item);
});
