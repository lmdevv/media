import { AlbumId, ArtistId, TrackId } from "@music/commands/ids";
import type { PlaylistEntry, Track } from "@music/commands/models";

/** What a playlist row says in place of a song in a library you can't read. */
export const WITHHELD_TITLE = "A song you can't play";

/** What a playlist row says under {@link WITHHELD_TITLE}, in place of the artist. */
export const WITHHELD_ARTIST = "In a library that isn't shared with you";

/**
 * The song a playlist row shows. The server sends nothing about a song in a library you can't
 * read, not even its IDs, so such a row gets a stand-in made from the entry alone; its IDs name
 * no song, and the row offers no action that would use them (`withheld` in `TrackList`).
 */
export const entryTrack = (entry: PlaylistEntry): Track =>
  entry.track ?? {
    id: TrackId.make(`withheld-${entry.itemId}`),
    title: WITHHELD_TITLE,
    artist: WITHHELD_ARTIST,
    artistId: ArtistId.make(`withheld-${entry.itemId}`),
    album: "",
    albumId: AlbumId.make(`withheld-${entry.itemId}`),
    trackNumber: null,
    discNumber: null,
    durationMs: entry.durationMs,
    codec: "",
    lossless: false,
    bitrate: null,
    sampleRate: null,
    bitDepth: null,
    artUrl: null,
    liked: false,
  };

/** The songs of a playlist that can play here, in order. */
export const playableTracks = (entries: ReadonlyArray<PlaylistEntry>): ReadonlyArray<Track> =>
  entries.flatMap((entry) => (entry.available && entry.track !== null ? [entry.track] : []));
