/**
 * How the app sums up an artist and lists the songs crediting them (ADR 0024, "Artist credits"):
 * their own songs, and the ones they share or only feature on.
 */
import { creditText, creditsOthers } from "./credits";
import { countOf } from "./format";
import type { AlbumCard, ArtistCard, ArtistId, Track, TrackId } from "./models";

/** How many top songs `music.artists.get` answers: an artist's first songs by title. */
export const TOP_SONGS = 10;

/** An artist's counts, as their card answers them. */
type ArtistCounts = Pick<ArtistCard, "albumCount" | "trackCount">;

/**
 * What an artist's row says under their name: their albums, or, for an artist with none, such as
 * one who only features, the songs crediting them.
 */
export const artistSummary = (artist: ArtistCounts): string =>
  artist.albumCount === 0 && artist.trackCount !== undefined
    ? countOf(artist.trackCount, "song")
    : countOf(artist.albumCount, "album");

/**
 * An artist page's counts: their albums when they have any, and the songs crediting them. An
 * artist the core hasn't counted songs for since it kept credits counts their albums' songs.
 */
export const artistStats = (
  artist: ArtistCounts,
  albums: ReadonlyArray<Pick<AlbumCard, "trackCount">>,
): string => {
  const songs = artist.trackCount ?? albums.reduce((sum, album) => sum + album.trackCount, 0);

  return [
    artist.albumCount === 0 ? null : countOf(artist.albumCount, "album"),
    countOf(songs, "song"),
  ]
    .filter((part) => part !== null)
    .join(" · ");
};

/**
 * Whether an artist has songs past their top songs, which their page's Songs list then opens:
 * their song count, when known, is more than the top songs hold. The top songs read a bounded
 * window of the artist's songs before hiding the ones the listener may not play, so a short list
 * doesn't prove there are no more. Without a count, a full list of top songs may have more.
 */
export const hasMoreSongs = (artist: ArtistCounts, topTracks: ReadonlyArray<unknown>): boolean =>
  artist.trackCount === undefined
    ? topTracks.length >= TOP_SONGS
    : artist.trackCount > topTracks.length;

/**
 * What a song's row on an artist's pages says under its title: the song's artists when it credits
 * anyone besides `artistId`, then its album, and the album's year when it is known.
 */
export const artistSongLine = (
  track: Pick<Track, "artist" | "artistId" | "credits" | "album">,
  artistId: ArtistId,
  year: number | null,
): string =>
  [
    creditsOthers(track, artistId) ? creditText(track) : null,
    track.album,
    year === null ? null : String(year),
  ]
    .filter((part) => part !== null)
    .join(" · ");

/** `tracks` without a later row of a song already listed, as two pages may both hold one. */
export const distinctTracks = <Song extends { readonly id: TrackId }>(
  tracks: ReadonlyArray<Song>,
): ReadonlyArray<Song> => {
  const seen = new Set<TrackId>();

  return tracks.filter((track) => {
    if (seen.has(track.id)) return false;

    seen.add(track.id);

    return true;
  });
};
