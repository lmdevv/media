/**
 * Search results as A10 lays them out. "All" leads with the top result, then a few songs, albums,
 * and artists, each with See all when there are more; a filter chip shows one kind in full. The
 * screen renders the rows in one recycled list, so the layout is a flat array of typed rows.
 */
import type { AlbumCard, ArtistCard, SearchResults, Track } from "@music/commands/models";
import { foldSearchText } from "@music/commands/search-text";

/** The chips over the results. */
export const SEARCH_FILTERS = [
  { value: "all", label: "All" },
  { value: "songs", label: "Songs" },
  { value: "albums", label: "Albums" },
  { value: "artists", label: "Artists" },
] as const;

/** Which kinds of result show. */
export type SearchFilter = (typeof SEARCH_FILTERS)[number]["value"];

/** How many of each kind "All" shows before See all. */
const ALL_LIMITS = { songs: 4, albums: 3, artists: 3 } as const;

/** The result "All" leads with. */
export type TopResult =
  | { readonly kind: "artist"; readonly artist: ArtistCard }
  | { readonly kind: "album"; readonly album: AlbumCard }
  | { readonly kind: "track"; readonly track: Track; readonly index: number };

/**
 * The best match for `query`: an artist, album, or song whose name starts with it, in that order
 * (people search for artists by name most), else the first song, album, or artist found.
 */
export const topResult = (results: SearchResults, query: string): TopResult | null => {
  const folded = foldSearchText(query.trim());
  const starts = (text: string): boolean => foldSearchText(text).startsWith(folded);

  const artist = results.artists.find((candidate) => starts(candidate.name));

  if (artist !== undefined) return { kind: "artist", artist };

  const album = results.albums.find((candidate) => starts(candidate.title));

  if (album !== undefined) return { kind: "album", album };

  const index = results.tracks.findIndex((candidate) => starts(candidate.title));
  const track = results.tracks[Math.max(index, 0)];

  if (track !== undefined) return { kind: "track", track, index: Math.max(index, 0) };

  const firstAlbum = results.albums[0];

  if (firstAlbum !== undefined) return { kind: "album", album: firstAlbum };

  const firstArtist = results.artists[0];

  return firstArtist === undefined ? null : { kind: "artist", artist: firstArtist };
};

/** A row of the results list. `index` places a song in `results.tracks`, the list it plays. */
export type SearchRow =
  | {
      readonly kind: "section";
      readonly key: string;
      readonly title: string;
      /** The chip See all switches to; null when the section shows everything. */
      readonly more: SearchFilter | null;
    }
  | { readonly kind: "top"; readonly key: string; readonly top: TopResult }
  | { readonly kind: "track"; readonly key: string; readonly track: Track; readonly index: number }
  | { readonly kind: "album"; readonly key: string; readonly album: AlbumCard }
  | { readonly kind: "artist"; readonly key: string; readonly artist: ArtistCard };

/** The key the top result's own row would have in its section, so it isn't listed twice. */
const rowKeyOf = (top: TopResult): string => {
  if (top.kind === "artist") return `artist:${top.artist.id}`;

  if (top.kind === "album") return `album:${top.album.id}`;

  return `track:${top.track.id}`;
};

/** Whether the search found nothing at all (G03). */
export const foundNothing = (results: SearchResults): boolean =>
  results.tracks.length === 0 && results.albums.length === 0 && results.artists.length === 0;

const trackRows = (tracks: ReadonlyArray<{ track: Track; index: number }>): Array<SearchRow> =>
  tracks.map(({ track, index }) => ({ kind: "track", key: `track:${track.id}`, track, index }));

const albumRows = (albums: ReadonlyArray<AlbumCard>): Array<SearchRow> =>
  albums.map((album) => ({ kind: "album", key: `album:${album.id}`, album }));

const artistRows = (artists: ReadonlyArray<ArtistCard>): Array<SearchRow> =>
  artists.map((artist) => ({ kind: "artist", key: `artist:${artist.id}`, artist }));

/** A titled section of at most `limit` rows, with See all when it holds more. */
const section = <Item>(
  title: string,
  filter: SearchFilter,
  items: ReadonlyArray<Item>,
  limit: number,
  rows: (items: ReadonlyArray<Item>) => Array<SearchRow>,
): Array<SearchRow> =>
  items.length === 0
    ? []
    : [
        {
          kind: "section",
          key: `section:${filter}`,
          title,
          more: items.length > limit ? filter : null,
        },
        ...rows(items.slice(0, limit)),
      ];

/** The rows for `results` under `filter`. */
export const searchRows = (
  results: SearchResults,
  filter: SearchFilter,
  query: string,
): ReadonlyArray<SearchRow> => {
  const tracks = results.tracks.map((track, index) => ({ track, index }));

  if (filter === "songs") return trackRows(tracks);

  if (filter === "albums") return albumRows(results.albums);

  if (filter === "artists") return artistRows(results.artists);

  const top = topResult(results, query);
  const topKey = top === null ? null : rowKeyOf(top);

  return [
    ...(top === null
      ? []
      : [
          { kind: "section", key: "section:top", title: "Top result", more: null } as const,
          { kind: "top", key: "top", top } as const,
        ]),
    ...section(
      "Songs",
      "songs",
      tracks.filter(({ track }) => `track:${track.id}` !== topKey),
      ALL_LIMITS.songs,
      trackRows,
    ),
    ...section(
      "Albums",
      "albums",
      results.albums.filter((album) => `album:${album.id}` !== topKey),
      ALL_LIMITS.albums,
      albumRows,
    ),
    ...section(
      "Artists",
      "artists",
      results.artists.filter((artist) => `artist:${artist.id}` !== topKey),
      ALL_LIMITS.artists,
      artistRows,
    ),
  ];
};
