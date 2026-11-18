import { asAlbumId, asArtistId, asTrackId } from "./models";
import type { AlbumCard, ArtistCard, Track } from "./models";

/** A song called `title` by `artist`, with its ID taken from the title. */
export const trackOf = (title: string, artist = "Massive Attack", album = "Blue Lines"): Track => ({
  id: asTrackId(`t-${title}`),
  title,
  artist,
  artistId: asArtistId(`ar-${artist}`),
  album,
  albumId: asAlbumId(`al-${album}`),
  trackNumber: null,
  discNumber: null,
  durationMs: 240_000,
  codec: "flac",
  lossless: true,
  bitrate: null,
  sampleRate: null,
  bitDepth: null,
  artUrl: `/music/art/${album}`,
  liked: false,
});

/** An album called `title` by `artist`. */
export const albumOf = (
  title: string,
  artist = "Massive Attack",
  year: number | null = 1991,
): AlbumCard => ({
  id: asAlbumId(`al-${title}`),
  title,
  artist,
  artistId: asArtistId(`ar-${artist}`),
  year,
  artUrl: `/music/art/${title}`,
  trackCount: 9,
});

/** An artist called `name`. */
export const artistOf = (name: string, albumCount = 1): ArtistCard => ({
  id: asArtistId(`ar-${name}`),
  name,
  albumCount,
  artUrl: null,
});
