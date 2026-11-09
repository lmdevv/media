import { basename } from "node:path";

import type { FunctionArgs } from "convex/server";

import type { api } from "../../convex/_generated/api";

/** One file with its title and episode, as the movies scanner sends it. */
export type ScannedItem = FunctionArgs<typeof api.movies.scanner.upsert>["items"][number];

type ScannedTitle = ScannedItem["title"];

const NO_IDS = { tmdb: null, imdb: null, tvdb: null };

const EMPTY_PROBE = {
  container: "matroska",
  durationMs: 0,
  bitRate: null,
  video: [],
  audio: [],
  subtitles: [],
};

/** A probe of a file with one H.264 video stream, which a scan queues scrub thumbnails for. */
const VIDEO_PROBE = {
  ...EMPTY_PROBE,
  durationMs: 60_000,
  video: [
    {
      index: 0,
      codec: "h264",
      profile: null,
      width: 1920,
      height: 1080,
      frameRate: 24,
      bitDepth: 8,
      pixelFormat: "yuv420p",
      hdr: "none" as const,
      bitRate: null,
    },
  ],
};

/** A title as a scan reads it, unmatched, with `fields` over the defaults. */
export const scannedTitle = (
  kind: ScannedTitle["kind"],
  matchKey: string,
  name: string,
  ageRating: number | null = null,
): ScannedTitle => ({
  kind,
  matchKey,
  name,
  sortName: null,
  year: null,
  overview: null,
  tagline: null,
  genres: [],
  certification: null,
  ageRating,
  runtimeMs: null,
  artwork: { poster: null, backdrop: null, logo: null },
  externalIds: NO_IDS,
  matchStatus: "unmatched",
});

const scannedFile = (path: string, sizeBytes: number, mtimeMs: number, video: boolean) => ({
  path,
  sizeBytes,
  mtimeMs,
  probe: video ? VIDEO_PROBE : EMPTY_PROBE,
  externalSubtitles: [],
  versionName: null,
});

/** A movie file, its own title keyed by its path, as a scan of loose files would name it. */
export const movieFile = (
  path: string,
  sizeBytes = 1,
  mtimeMs = 1,
  title: ScannedTitle = scannedTitle("movie", `file:${path}`, basename(path)),
  video = false,
): ScannedItem => ({ file: scannedFile(path, sizeBytes, mtimeMs, video), title, episode: null });

/** One episode of a show, its file at `path`. */
export const episodeFile = (
  path: string,
  show: ScannedTitle,
  seasonNumber: number,
  episodeNumber: number,
  video = false,
  size = 1,
): ScannedItem => ({
  file: scannedFile(path, size, size, video),
  title: show,
  episode: {
    seasonNumber,
    episodeNumber,
    name: null,
    overview: null,
    airDate: null,
    runtimeMs: null,
    still: null,
    seasonName: null,
    seasonPoster: null,
  },
});
