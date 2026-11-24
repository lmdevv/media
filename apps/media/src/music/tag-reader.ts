import { distinctNames, joinCreditNames } from "@media/contracts/artist-credits";
import type { LocalLyricSet } from "@media/contracts/models/music";
import { Effect, Option, Schema } from "effect";
import { type IAudioMetadata, type ITag, parseFile, selectCover } from "music-metadata";

import { normalizeCodec } from "./audio-format.ts";
import { embeddedLyrics } from "./lyrics/embedded.ts";

/** A file's tags could not be read, or it holds no audio stream. */
class TagReadError extends Schema.TaggedError<TagReadError, { readonly brand: unique symbol }>()(
  "TagReadError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not read tags: ${this.path}`;
  }
}

/**
 * The version of this tag reader, which a song's row keeps (`tagsReader`). A scan reads a file
 * whose row an older reader wrote again whatever its size and modification time, as it does a
 * file whose lyrics an older lyrics reader read (`LYRICS_READER_VERSION`). Version 1 reads
 * separate artist values, which the core credits one by one (ADR 0024, "Artist credits").
 */
export const TAGS_READER_VERSION = 1;

/** What one file says about itself. Absent tags are `undefined`. */
interface TrackTags {
  readonly title: string | undefined;
  /** The artist as a client shows it: the artist tag, or its separate values joined. */
  readonly artist: string | undefined;
  /** The artists when the tags hold them as two or more separate values. */
  readonly artists: ReadonlyArray<string> | undefined;
  readonly albumArtist: string | undefined;
  readonly albumArtists: ReadonlyArray<string> | undefined;
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
  /** Whether its tags mark it explicit (see `isExplicit`). */
  readonly explicit: boolean;
}

const text = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/**
 * Separate artist values, trimmed and without a later spelling of one already named, when there
 * are two or more: music-metadata lists a multi-value tag's values, or the one string a tag that
 * names several artists at once holds.
 */
const separateValues = (
  values: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined => {
  const names = distinctNames((values ?? []).flatMap((value) => text(value) ?? []));

  return names.length >= 2 ? names : undefined;
};

/**
 * The artist a client shows for a tag and its separate values: the tag, unless it is only the
 * first value, as music-metadata reads a tag repeated once per artist; then the values joined.
 */
const shownArtist = (
  tag: string | undefined,
  values: ReadonlyArray<string> | undefined,
): string | undefined =>
  values !== undefined && (tag === undefined || tag === values[0]) ? joinCreditNames(values) : tag;

const positive = (value: number | null | undefined): number | undefined =>
  value === null || value === undefined || !Number.isFinite(value) || value <= 0
    ? undefined
    : value;

/**
 * The tags that carry iTunes' content advisory: the MP4 `rtng` atom and its freeform form, the
 * Vorbis and APE `ITUNESADVISORY` field, and an ID3 `TXXX` frame of that name. Their values are
 * 0 for none, 1 for explicit, 2 for clean, and 4 for explicit as older iTunes wrote it.
 */
const ADVISORY_TAG =
  /^(?:rtng|ITUNESADVISORY|TXXX:ITUNESADVISORY|----:com\.apple\.iTunes:ITUNESADVISORY)$/iu;

const EXPLICIT_VALUES: ReadonlySet<string> = new Set(["1", "4", "explicit"]);

/** A tag value as music-metadata reads an advisory: a number, or text holding one. */
const decodeAdvisory = Schema.decodeUnknownOption(Schema.Union([Schema.Finite, Schema.String]));

const marksExplicit = (tag: ITag): boolean => {
  if (!ADVISORY_TAG.test(tag.id)) return false;

  const values: ReadonlyArray<unknown> = Array.isArray(tag.value) ? tag.value : [tag.value];

  return values.some((value) =>
    Option.exists(decodeAdvisory(value), (advisory) =>
      EXPLICIT_VALUES.has(String(advisory).trim().toLowerCase()),
    ),
  );
};

/**
 * Whether a file's tags mark it explicit, which a kid's explicit filter hides (D17). It reads
 * iTunes' content advisory wherever a tag format carries it (`ADVISORY_TAG`), and is false for
 * every other file.
 */
export const isExplicit = (metadata: Pick<IAudioMetadata, "native">): boolean =>
  Object.values(metadata.native).some((tags) => tags.some(marksExplicit));

const parseTags = (path: string, options: { readonly covers: boolean }) =>
  Effect.tryPromise({
    try: () => parseFile(path, { duration: false, skipCovers: !options.covers }),
    catch: (cause) => new TagReadError({ path, cause }),
  });

/**
 * Reads tags, separate artist values, duration, codec, embedded art, embedded lyrics, and the
 * explicit advisory from the file at `path`.
 */
export const readTrackTags = Effect.fn("TagReader.read")(function* (path: string) {
  const metadata = yield* parseTags(path, { covers: true });
  const { common, format } = metadata;

  if (format.codec === undefined) {
    return yield* new TagReadError({ path, cause: new Error("No audio stream found") });
  }

  const artists = separateValues(common.artists);
  const albumArtists = separateValues(common.albumartists);

  const tags: TrackTags = {
    title: text(common.title),
    artist: shownArtist(text(common.artist), artists),
    artists,
    albumArtist: shownArtist(text(common.albumartist), albumArtists),
    albumArtists,
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
    explicit: isExplicit(metadata),
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
