/**
 * The words of Library → Downloaded (Paper's D09 and D10): the category's count, the page's
 * filters and storage summary, and each download's line under its title.
 */
import type { TrackId } from "@music/commands/ids";
import type {
  DownloadedEntry,
  DownloadedItem,
  DownloadedSong,
  DownloadedSongs,
  DownloadStatus,
  DownloadUsage,
  TrackDownloadState,
} from "@music/sdk/downloads";
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

/** The rows a filter shows; `songs` lists every song on the phone instead. */
export const entriesFor = (
  filter: Exclude<DownloadedFilter, "songs">,
  entries: ReadonlyArray<DownloadedEntry>,
): ReadonlyArray<DownloadedEntry> =>
  filter === "all"
    ? entries
    : entries.filter(
        (entry) =>
          entry.kind === "download" &&
          entry.item.target.kind === (filter === "albums" ? "album" : "playlist"),
      );

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

const statusLine = (
  status: DownloadStatus,
  settled: string | null,
  who: string | null,
): DownloadedLine => {
  const line = (
    text: string | null,
    glyph: TrackDownloadState | null = null,
    tone: DownloadedLine["tone"] = "muted",
  ): DownloadedLine => ({
    text: [text, who].filter((part) => part !== null).join(" · "),
    glyph,
    tone,
  });

  return Match.value(status).pipe(
    Match.discriminatorsExhaustive("kind")({
      none: () => line(settled),
      downloaded: () => line(settled),
      included: () => line(settled),
      unavailable: () => line("No longer available"),
      queued: () => line("Waiting to download", "queued"),
      waiting: ({ reason }) =>
        line(reason === "offline" ? "Waiting for your server" : "Waiting for space", "queued"),
      downloading: ({ done, total }) =>
        line(`Downloading ${String(done)} of ${String(total)}`, "downloading"),
      failed: ({ failed, total }) =>
        line(`Couldn’t download ${String(failed)} of ${String(total)}`, "failed", "danger"),
    }),
  );
};

/** `Album · Massive Attack`, `Playlist · 24 songs`, or where a download still coming stands. */
export const downloadedLine = (item: DownloadedItem): DownloadedLine =>
  statusLine(
    item.status,
    KINDS[item.target.kind],
    item.target.kind === "playlist" && item.songs !== null
      ? countOf(item.songs, "song")
      : item.subtitle,
  );

/** A song on the Songs page (D10c): its artist, or where its download stands. */
export const ownSongLine = (item: DownloadedSong): DownloadedLine =>
  statusLine(item.status, null, item.subtitle);

/** The Songs row (D10b): how many songs, or where the ones still coming stand. */
export const ownSongsLine = (songs: DownloadedSongs): DownloadedLine =>
  statusLine(songs.status, countOf(songs.items.length, "song"), null);

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

/**
 * The Library row's figure: how many songs, such as `55 songs` (D09), or while the server is out
 * of reach how much space they take, such as `2.4 GB` (D11); none while nothing is downloaded.
 */
export const downloadedDetail = (usage: DownloadUsage, offline: boolean): string | null => {
  if (usage.tracks === 0) return null;

  return offline ? formatBytes(usage.bytes) : countOf(usage.tracks, "song");
};

/** Library's line under its title while offline, such as `55 songs on this iPhone` (D11). */
export const onThisPhone = (usage: DownloadUsage): string =>
  `${countOf(usage.tracks, "song")} on this iPhone`;

/** D10c's mono line over its songs, such as `3 SONGS`. */
export const ownSongsSummary = (songs: DownloadedSongs): string =>
  countOf(songs.items.length, "song").toLocaleUpperCase();

/** D10c's sentence under its summary. */
export const OWN_SONGS_NOTE =
  "Downloaded on their own. A song in a downloaded album or playlist is listed there.";

/** D10c's empty state, which also shows once a downloaded album or playlist holds every song. */
export const OWN_SONGS_EMPTY: EmptyCopy = {
  title: "No songs downloaded on their own",
  body: "Songs you download from their menu show here.\nA song in a downloaded album or playlist is listed there.",
};

/** What a tap on a song of D10c plays, and from where. */
export interface OwnSongsQueue {
  readonly trackIds: ReadonlyArray<TrackId>;
  readonly index: number;
}

/**
 * A tap on `tapped` plays the songs on this phone from it, as an offline album does; a song still
 * coming plays on its own, so the queue never waits on songs this phone doesn't hold.
 */
export const ownSongsQueue = (
  items: ReadonlyArray<DownloadedSong>,
  tapped: DownloadedSong,
): OwnSongsQueue => {
  if (tapped.status.kind !== "downloaded") return { trackIds: [tapped.target.id], index: 0 };

  const here = items.filter((item) => item.status.kind === "downloaded");

  return {
    trackIds: here.map((item) => item.target.id),
    index: Math.max(
      0,
      here.findIndex((item) => item.target.id === tapped.target.id),
    ),
  };
};
