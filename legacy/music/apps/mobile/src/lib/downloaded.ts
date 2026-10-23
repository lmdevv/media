/**
 * The words of Library → Downloaded (Paper's D09 and D10): the category's count, the page's
 * filters and storage summary, and each download's line under its title.
 */
import type { DownloadedItem, DownloadUsage, TrackDownloadState } from "@music/sdk/downloads";
import { Match } from "effect";

import { countOf, formatBytes } from "./format";

/** The page's filter chips. */
export const DOWNLOADED_FILTERS = [
  { value: "all", label: "All" },
  { value: "albums", label: "Albums" },
  { value: "playlists", label: "Playlists" },
  { value: "songs", label: "Songs" },
] as const;

/** What the page lists. */
export type DownloadedFilter = (typeof DOWNLOADED_FILTERS)[number]["value"];

/** The downloads a filter shows; `songs` lists every song on the phone instead. */
export const downloadsFor = (
  filter: Exclude<DownloadedFilter, "songs">,
  downloads: ReadonlyArray<DownloadedItem>,
): ReadonlyArray<DownloadedItem> =>
  filter === "all"
    ? downloads
    : downloads.filter((item) => item.target.kind === (filter === "albums" ? "album" : "playlist"));

/** An empty state's title and body. */
interface EmptyCopy {
  readonly title: string;
  readonly body: string;
}

/** The empty state's words: for a phone with nothing downloaded, or for a filter with nothing in it. */
export const downloadedEmpty = (filter: DownloadedFilter, anything: boolean): EmptyCopy => {
  if (!anything || filter === "all") {
    return {
      title: "Nothing downloaded yet",
      body: "Download an album or playlist from its page\nto play it with no connection.",
    };
  }

  const how = {
    albums: "Download an album from its page",
    playlists: "Download a playlist from its page",
    songs: "Download a song from its menu",
  }[filter];

  return { title: `No ${filter} downloaded`, body: `${how}\nto play it with no connection.` };
};

/** `55 SONGS · 3 ALBUMS · 1 PLAYLIST`, the mono line over the list. */
export const downloadedSummary = (
  usage: DownloadUsage,
  downloads: ReadonlyArray<DownloadedItem>,
): string =>
  [
    countOf(usage.tracks, "song"),
    countOf(downloads.filter((item) => item.target.kind === "album").length, "album"),
    countOf(downloads.filter((item) => item.target.kind === "playlist").length, "playlist"),
  ]
    .join(" · ")
    .toLocaleUpperCase();

/** The sentence under the summary, with the free space when iOS reports it. */
export const downloadedNote = (usage: DownloadUsage): string =>
  usage.freeBytes === null
    ? "Plays with no connection to your server."
    : `Plays with no connection to your server. ${formatBytes(usage.freeBytes)} still free on this iPhone.`;

/** The line under a download's title, the glyph before it, and its color. */
export interface DownloadedLine {
  readonly text: string;
  readonly glyph: TrackDownloadState | null;
  readonly tone: "muted" | "danger";
}

const KINDS = { track: "Song", album: "Album", playlist: "Playlist" } as const;

/** `Album · Massive Attack`, `Playlist · 24 songs`, or where a download still coming stands. */
export const downloadedLine = (item: DownloadedItem): DownloadedLine => {
  // A playlist names its songs, as D10 draws it; an album or song names its artist.
  const who =
    item.target.kind === "playlist" && item.songs !== null
      ? countOf(item.songs, "song")
      : item.subtitle;

  const line = (text: string, glyph: TrackDownloadState | null = null): DownloadedLine => ({
    text: `${text} · ${who}`,
    glyph,
    tone: "muted",
  });

  return Match.value(item.status).pipe(
    Match.discriminatorsExhaustive("kind")({
      none: () => line(KINDS[item.target.kind]),
      downloaded: () => line(KINDS[item.target.kind]),
      included: () => line(KINDS[item.target.kind]),
      unavailable: () => line("No longer available"),
      queued: () => line("Waiting to download", "queued"),
      waiting: ({ reason }) =>
        line(reason === "offline" ? "Waiting for your server" : "Waiting for space", "queued"),
      downloading: ({ done, total }) =>
        line(`Downloading ${String(done)} of ${String(total)}`, "downloading"),
      failed: ({ failed, total }): DownloadedLine => ({
        text: `Couldn’t download ${String(failed)} of ${String(total)} · ${who}`,
        glyph: "failed",
        tone: "danger",
      }),
    }),
  );
};

/**
 * The Settings row's subtitle (D15), without Paper's "cellular": the app can't tell cellular from
 * Wi-Fi yet, so there is no cellular setting.
 */
export const downloadsSettingsLine = (usage: DownloadUsage): string =>
  usage.bytes === 0 ? "Quality and storage" : `${formatBytes(usage.bytes)} · quality and storage`;

/** D16's storage line, such as `55 songs · 2.4 GB`. */
export const storageLine = (usage: DownloadUsage): string =>
  usage.tracks === 0
    ? "Nothing downloaded"
    : `${countOf(usage.tracks, "song")} · ${formatBytes(usage.bytes)}`;

/** The Library row's count, such as `55 songs`; none while nothing is downloaded. */
export const downloadedCount = (usage: DownloadUsage): string | null =>
  usage.tracks === 0 ? null : countOf(usage.tracks, "song");
