/**
 * What this phone keeps about its downloads, as schemas its vault rows decode through. The core
 * keeps only the songs a device holds (`core.downloads.*`), so the albums, playlists, and songs
 * someone downloads are kept here as pins, and each pin's songs come from the core's album and
 * playlist reads.
 */
import { MusicStreamProfile } from "@media/contracts/music-playback";
import { Schema } from "effect";

export const TrackId = Schema.String.pipe(Schema.brand("Id<tracks>"));

export type TrackId = typeof TrackId.Type;

export const AlbumId = Schema.String.pipe(Schema.brand("Id<albums>"));

export type AlbumId = typeof AlbumId.Type;

export const ArtistId = Schema.String.pipe(Schema.brand("Id<artists>"));

export type ArtistId = typeof ArtistId.Type;

export const PlaylistId = Schema.String.pipe(Schema.brand("Id<playlists>"));

export type PlaylistId = typeof PlaylistId.Type;

/** A download's key on this phone: its target's kind and id, such as `album:<id>`. */
export const DownloadPinId = Schema.String.pipe(Schema.brand("DownloadPinId"));

export type DownloadPinId = typeof DownloadPinId.Type;

export const StreamProfile = MusicStreamProfile;

export type StreamProfile = typeof StreamProfile.Type;

/** The query parameter that asks the media server for a finished file, never a live encode. */
export const FINISHED_PARAM = "finished";

/**
 * Every artist a song credits, in order, as the core answers them: the first is the song's
 * `artistId`, and each name is spelled as the song's tags spell it.
 */
export const TrackCredits = Schema.Array(
  Schema.Struct({ artistId: ArtistId, name: Schema.String }),
);

/** A song as a download keeps it: the core's song without `liked`, so a like never refetches it. */
export const OfflineTrack = Schema.Struct({
  id: TrackId,
  title: Schema.String,
  artist: Schema.String,
  artistId: ArtistId,
  /**
   * Absent from a copy kept before songs carried credits, and from a song the core hasn't read
   * again since; such a song credits `artistId`.
   */
  credits: Schema.optionalKey(TrackCredits),
  album: Schema.String,
  albumId: AlbumId,
  trackNumber: Schema.NullOr(Schema.Finite),
  discNumber: Schema.NullOr(Schema.Finite),
  durationMs: Schema.Finite,
  codec: Schema.String,
  lossless: Schema.Boolean,
  bitrate: Schema.NullOr(Schema.Finite),
  sampleRate: Schema.NullOr(Schema.Finite),
  bitDepth: Schema.NullOr(Schema.Finite),
  /** The cover's path on the media server with its image ticket, or null. */
  artUrl: Schema.NullOr(Schema.String),
});

export interface OfflineTrack extends Schema.Schema.Type<typeof OfflineTrack> {}

export const DownloadTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("track"), id: TrackId }),
  Schema.Struct({ kind: Schema.Literal("album"), id: AlbumId }),
  Schema.Struct({ kind: Schema.Literal("playlist"), id: PlaylistId }),
]);

export type DownloadTarget = typeof DownloadTarget.Type;

const downloadPinFields = {
  id: DownloadPinId,
  target: DownloadTarget,
  createdAt: Schema.Finite,
};

/**
 * One song, album, or playlist this phone keeps. It is `available: false` once its target is gone
 * or no longer yours to read: the phone deletes what it holds for it, and the pin stays until it is
 * removed.
 */
export const DownloadPin = Schema.Union([
  Schema.Struct({
    ...downloadPinFields,
    available: Schema.Literal(true),
    title: Schema.String,
    /** The artist of a song or album; the owner of a playlist. */
    subtitle: Schema.String,
    artUrl: Schema.NullOr(Schema.String),
    /** The cover's content hash, which stays the same while `artUrl`'s ticket changes. */
    artHash: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ ...downloadPinFields, available: Schema.Literal(false) }),
]);

export type DownloadPin = typeof DownloadPin.Type;

/**
 * What the phone does with one song of a download:
 *
 * - `fetchable`: fetch it when it holds no copy of this revision.
 * - `missing`: the core no longer serves it to this phone. Keep a copy you hold; there is nothing
 *   to fetch.
 * - `held`: the core has not said yet what it keeps. Keep a copy you hold, fetch nothing, and
 *   delete nothing.
 */
export const ManifestEntryState = Schema.Literals(["fetchable", "missing", "held"]);

export type ManifestEntryState = typeof ManifestEntryState.Type;

export interface ManifestEntry {
  readonly track: OfflineTrack;
  /** The file's revision as `core.downloads.list` names it; a copy of another is fetched again. */
  readonly rev: string;
  readonly artHash: string | null;
  readonly state: ManifestEntryState;
}

/** The songs a download holds now, in album or playlist order. */
export interface DownloadManifest {
  readonly pin: DownloadPin;
  readonly entries: ReadonlyArray<ManifestEntry>;
}

const LyricWord = Schema.Struct({
  text: Schema.String,
  startMs: Schema.Finite,
  endMs: Schema.NullOr(Schema.Finite),
});

const LyricLine = Schema.Struct({
  text: Schema.String,
  startMs: Schema.Finite,
  endMs: Schema.NullOr(Schema.Finite),
  words: Schema.NullOr(Schema.Array(LyricWord)),
  voice: Schema.NullOr(Schema.String),
});

const LyricSet = Schema.Struct({
  kind: Schema.Literals(["main", "translation", "pronunciation"]),
  lang: Schema.NullOr(Schema.String),
  origin: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("sidecar"),
      fileName: Schema.String,
      format: Schema.Literals(["lrc", "elrc", "ttml", "vtt", "srt", "txt", "lyricsfile"]),
    }),
    Schema.Struct({
      type: Schema.Literal("embedded"),
      tag: Schema.Literals([
        "id3:USLT",
        "id3:SYLT",
        "vorbis:LYRICS",
        "vorbis:UNSYNCEDLYRICS",
        "vorbis:SYNCEDLYRICS",
        "mp4:lyr",
        "other",
      ]),
    }),
    Schema.Struct({ type: Schema.Literal("lrclib"), recordId: Schema.Finite }),
  ]),
  body: Schema.Union([
    Schema.Struct({ type: Schema.Literal("synced"), lines: Schema.Array(LyricLine) }),
    Schema.Struct({ type: Schema.Literal("plain"), text: Schema.String }),
  ]),
});

const LyricsSource = Schema.Literals(["file", "lrclib"]);

/**
 * The lyrics a phone keeps with a downloaded song, as `music.lyrics.get` answers them, less a
 * lookup still pending: one never finishes without the server.
 */
export const OfflineLyrics = Schema.Union([
  Schema.Struct({ status: Schema.Literal("none") }),
  Schema.Struct({ status: Schema.Literal("instrumental") }),
  Schema.Struct({
    status: Schema.Literal("synced"),
    source: LyricsSource,
    main: LyricSet,
    extras: Schema.Array(LyricSet),
  }),
  Schema.Struct({
    status: Schema.Literal("plain"),
    source: LyricsSource,
    main: LyricSet,
    extras: Schema.Array(LyricSet),
  }),
]);

export type OfflineLyrics = typeof OfflineLyrics.Type;

/** The version of the lyrics a phone keeps: a digest of their JSON. */
export const LyricsRevision = Schema.NonEmptyString.pipe(Schema.brand("LyricsRevision"));

export type LyricsRevision = typeof LyricsRevision.Type;

/**
 * How a downloaded song's lyrics differ from what the phone keeps: `Changed` keeps `lyrics` at
 * `rev`; `Removed` keeps none.
 */
export const LyricsChange = Schema.TaggedUnion({
  Changed: { trackId: TrackId, rev: LyricsRevision, lyrics: OfflineLyrics },
  Removed: { trackId: TrackId },
});

export type LyricsChange = typeof LyricsChange.Type;
