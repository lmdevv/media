/** Server-shaped records for tests, decoded through the real schemas so their IDs are branded. */
import { AlbumCard, ArtistCard, Track } from "@music/commands/models";
import { Schema } from "effect";

const decodeTrack = Schema.decodeUnknownSync(Track);

const decodeAlbum = Schema.decodeUnknownSync(AlbumCard);

const decodeArtist = Schema.decodeUnknownSync(ArtistCard);

/** A song called `title` by `artist`, with its ID taken from the title. */
export const trackOf = (title: string, artist = "Massive Attack", album = "Blue Lines"): Track =>
  decodeTrack({
    id: `t-${title}`,
    title,
    artist,
    artistId: `ar-${artist}`,
    album,
    albumId: `al-${album}`,
    trackNumber: null,
    discNumber: null,
    durationMs: 240_000,
    codec: "flac",
    lossless: true,
    bitrate: null,
    sampleRate: null,
    bitDepth: null,
    artUrl: `/media/art/${album}`,
    liked: false,
  });

/** An album called `title` by `artist`. */
export const albumOf = (title: string, artist = "Massive Attack", year: number | null = 1991) =>
  decodeAlbum({
    id: `al-${title}`,
    title,
    artist,
    artistId: `ar-${artist}`,
    year,
    artUrl: `/media/art/${title}`,
    trackCount: 9,
  });

/** An artist called `name`. */
export const artistOf = (name: string, albumCount = 1) =>
  decodeArtist({ id: `ar-${name}`, name, albumCount, artUrl: null });
