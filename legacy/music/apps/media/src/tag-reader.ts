/** Reads audio tags, technical details, and embedded lyrics from one file with `music-metadata`. */
import type { LocalLyricSet } from "@music/commands/lyrics";
import { Effect, Schema } from "effect";
import { parseFile, selectCover } from "music-metadata";

import { normalizeCodec } from "./audio-format.ts";
import { embeddedLyrics } from "./lyrics/embedded.ts";

/** A file's tags could not be read. */
class TagReadError extends Schema.TaggedError<TagReadError>()("TagReadError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not read tags: ${this.path}`;
  }
}

/** What one file says about itself. Absent tags are `undefined`. */
interface TrackTags {
  readonly title: string | undefined;
  readonly artist: string | undefined;
  readonly albumArtist: string | undefined;
  readonly album: string | undefined;
  readonly trackNumber: number | undefined;
  readonly discNumber: number | undefined;
  readonly year: number | undefined;
  readonly genre: string | undefined;
  readonly durationMs: number;
  readonly codec: string;
  readonly lossless: boolean;
  readonly bitrate: number | undefined;
  readonly sampleRate: number | undefined;
  readonly bitDepth: number | undefined;
  /** Bytes of the embedded front cover, or the first embedded picture. */
  readonly picture: Uint8Array | undefined;
  /** The lyrics in its tags (see `embeddedLyrics`). */
  readonly lyrics: ReadonlyArray<LocalLyricSet>;
}

const text = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

const positive = (value: number | null | undefined): number | undefined =>
  value === null || value === undefined || !Number.isFinite(value) || value <= 0
    ? undefined
    : value;

/** Parses the tags of the file at `path`, its pictures too when `covers` is set. */
const parseTags = (path: string, options: { readonly covers: boolean }) =>
  Effect.tryPromise({
    try: () => parseFile(path, { duration: false, skipCovers: !options.covers }),
    catch: (cause) => new TagReadError({ path, cause }),
  });

/** Reads tags, duration, codec, embedded art, and embedded lyrics from the file at `path`. */
export const readTrackTags = Effect.fn("TagReader.read")(function* (path: string) {
  const metadata = yield* parseTags(path, { covers: true });

  const { common, format } = metadata;

  // music-metadata accepts some junk files; without a codec there is nothing to play.
  if (format.codec === undefined) {
    return yield* new TagReadError({ path, cause: new Error("No audio stream found") });
  }

  const tags: TrackTags = {
    title: text(common.title),
    artist: text(common.artist),
    albumArtist: text(common.albumartist),
    album: text(common.album),
    trackNumber: positive(common.track.no),
    discNumber: positive(common.disk.no),
    year: positive(common.year),
    genre: text(common.genre?.[0]),
    durationMs: Math.round((positive(format.duration) ?? 0) * 1000),
    codec: normalizeCodec(format.codec, path),
    lossless: format.lossless ?? false,
    bitrate: positive(format.bitrate === undefined ? undefined : Math.round(format.bitrate)),
    sampleRate: positive(format.sampleRate),
    bitDepth: positive(format.bitsPerSample),
    picture: selectCover(common.picture)?.data,
    lyrics: embeddedLyrics(metadata),
  };

  return tags;
});

/**
 * Reads only the lyrics in the tags of the file at `path`, skipping its pictures, for a file
 * whose audio and tags a scan already stored.
 */
export const readTagLyrics = Effect.fn("TagReader.readLyrics")(function* (path: string) {
  return embeddedLyrics(yield* parseTags(path, { covers: false }));
});
