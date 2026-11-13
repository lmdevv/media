import { basename, dirname } from "node:path";

import type { FunctionArgs } from "convex/server";

import type { api } from "../../convex/_generated/api";

/** One audio file with its tags and own lyrics, as the music scanner sends it. */
export type ScannedTrack = FunctionArgs<typeof api.music.scanner.upsert>["tracks"][number];

/** One of a song's own lyric sets, as the music scanner sends it. */
export type LyricSet = ScannedTrack["lyrics"][number];

/**
 * A file as a scan reads it: titled by its name, on the album named by its folder, by `Artist`,
 * one second of FLAC with no art and no lyrics, with `fields` over those.
 */
export const musicTrack = (
  path: string,
  size = 1000,
  mtimeMs = 0,
  fields: Partial<ScannedTrack> = {},
): ScannedTrack => ({
  path,
  size,
  mtimeMs,
  title: basename(path),
  artist: "Artist",
  album: basename(dirname(path)),
  durationMs: 1000,
  codec: "flac",
  lossless: true,
  explicit: false,
  lyricsFiles: "",
  lyricsReader: 1,
  lyrics: [],
  ...fields,
});

/** Plain main lyrics from a `.txt` file beside the song, of `text`. */
export const plainLyrics = (text: string, lang: string | null = "en"): LyricSet => ({
  kind: "main",
  lang,
  origin: { _tag: "Sidecar", fileName: "song.txt", format: "txt" },
  body: { _tag: "Plain", text },
});
