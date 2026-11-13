import { v } from "convex/values";
import type { Infer } from "convex/values";

import { nullable } from "../movies/validators";

const lyricWord = v.object({
  text: v.string(),
  startMs: v.number(),
  endMs: v.union(v.number(), v.null()),
});

const lyricLine = v.object({
  text: v.string(),
  startMs: v.number(),
  endMs: v.union(v.number(), v.null()),
  /** Set only when the source timed each word; never empty. */
  words: v.union(v.array(lyricWord), v.null()),
  /** The singer, when the source marks one (`v1`, `M`, a TTML agent). */
  voice: v.union(v.string(), v.null()),
});

const lyricBody = v.union(
  v.object({ _tag: v.literal("Synced"), lines: v.array(lyricLine) }),
  v.object({ _tag: v.literal("Plain"), text: v.string() }),
);

/**
 * One of a song's own lyric sets, from a file beside it or a tag inside it, never LRCLIB: old
 * music's `localLyricSet`, which `LocalLyricSet` in old music's commands encodes. The validator
 * checks its shape; `fit.ts` checks the rest (language tags, non-empty text and lines) in plain
 * TypeScript, as old music's Effect Schema did.
 */
export const localLyricSet = v.object({
  kind: v.union(v.literal("main"), v.literal("translation"), v.literal("pronunciation")),
  /** A BCP 47 tag in canonical case, such as `en` or `pt-BR`, or null for none. */
  lang: v.union(v.string(), v.null()),
  origin: v.union(
    v.object({
      _tag: v.literal("Sidecar"),
      fileName: v.string(),
      format: v.union(
        v.literal("lrc"),
        v.literal("elrc"),
        v.literal("ttml"),
        v.literal("vtt"),
        v.literal("srt"),
        v.literal("txt"),
        v.literal("lyricsfile"),
      ),
    }),
    v.object({
      _tag: v.literal("Embedded"),
      tag: v.union(
        v.literal("id3:USLT"),
        v.literal("id3:SYLT"),
        v.literal("vorbis:LYRICS"),
        v.literal("vorbis:UNSYNCEDLYRICS"),
        v.literal("vorbis:SYNCEDLYRICS"),
        v.literal("mp4:lyr"),
        v.literal("other"),
      ),
    }),
  ),
  body: lyricBody,
});

export type LocalLyricSet = Infer<typeof localLyricSet>;

const lyricsFields = {
  /** The lyric files beside the file, as `name:size:mtime` joined by `/`; empty when none. */
  lyricsFiles: v.string(),
  /** The version of the server's lyrics reader that read them. */
  lyricsReader: v.number(),
  /** The file's own lyric sets, from its lyric files and tags; none when it has none. */
  lyrics: v.array(localLyricSet),
};

/**
 * One audio file a scan read, with its tags and its own lyrics: old music's `scannedTrack`, plus
 * whether its tags mark it explicit, which a kid's explicit filter hides (D17).
 */
export const scannedTrack = v.object({
  ...lyricsFields,
  path: v.string(),
  size: v.number(),
  mtimeMs: v.number(),
  title: v.string(),
  artist: v.string(),
  /** The album's artist when the tags name one; the album files under it, else under `artist`. */
  albumArtist: v.optional(v.string()),
  album: v.string(),
  trackNumber: v.optional(v.number()),
  discNumber: v.optional(v.number()),
  year: v.optional(v.number()),
  genre: v.optional(v.string()),
  durationMs: v.number(),
  codec: v.string(),
  lossless: v.boolean(),
  bitrate: v.optional(v.number()),
  sampleRate: v.optional(v.number()),
  bitDepth: v.optional(v.number()),
  /** The artwork the scan found for the file, embedded or beside it, as the server stores it. */
  artHash: v.optional(v.string()),
  /** The folder artwork file beside the file, as `path:size:mtime`, so replacing it rescans. */
  folderArt: v.optional(v.string()),
  explicit: v.boolean(),
});

export type ScannedTrack = Infer<typeof scannedTrack>;

/** The lyrics a scan read again for a file whose audio did not change. */
export const scannedLyrics = v.object({ path: v.string(), ...lyricsFields });

export type ScannedLyrics = Infer<typeof scannedLyrics>;

/** A file the library knows, as a scan compares it with the disk: old music's fingerprint. */
export const knownTrack = v.object({
  path: v.string(),
  size: v.number(),
  mtimeMs: v.number(),
  missing: v.boolean(),
  folderArt: nullable(v.string()),
  lyricsFiles: v.string(),
  lyricsReader: v.number(),
  /** The size of the file's own lyrics as stored, null when it has none. */
  lyricsBytes: nullable(v.number()),
  durationMs: v.number(),
  title: v.string(),
  artist: v.string(),
  album: v.string(),
});
