/**
 * How the browse lists are sorted and laid out (A12 · Sort and view): albums by date added, title,
 * or artist, as a grid or a list; songs by title or artist. The server pages albums newest first
 * and songs by title, so any other order is applied here, over the whole list.
 */
import type { AlbumCard, Track } from "@music/commands/models";
import { foldSearchText } from "@music/commands/search-text";
import { compareText } from "@music/commands/text-order";
import { Option, Schema } from "effect";

/** An album order. */
export const AlbumSort = Schema.Literals(["added", "title", "artist"]);

/** An album order. */
export type AlbumSort = typeof AlbumSort.Type;

/** A song order. */
export const SongSort = Schema.Literals(["title", "artist"]);

/** A song order. */
export type SongSort = typeof SongSort.Type;

/** Album cards in two columns, or rows. */
export const AlbumLayout = Schema.Literals(["grid", "list"]);

/** Album cards in two columns, or rows. */
export type AlbumLayout = typeof AlbumLayout.Type;

/** Every browse list's order and layout, as this device remembers them. */
export const BrowseView = Schema.Struct({
  albums: Schema.Struct({ sort: AlbumSort, layout: AlbumLayout }),
  songs: Schema.Struct({ sort: SongSort }),
});

/** Every browse list's order and layout, as this device remembers them. */
export type BrowseView = typeof BrowseView.Type;

/** Albums newest first in a grid (A03) and songs by title (A05), as Paper draws them. */
export const DEFAULT_VIEW: BrowseView = {
  albums: { sort: "added", layout: "grid" },
  songs: { sort: "title" },
};

const StoredView = Schema.fromJsonString(BrowseView);

const decodeStored = Schema.decodeUnknownOption(StoredView);

/** The remembered view, or the default when none is stored or it no longer parses. */
export const decodeView = (stored: string | null): BrowseView =>
  Option.getOrElse(decodeStored(stored), () => DEFAULT_VIEW);

/** The view as it is stored. */
export const encodeView = Schema.encodeSync(StoredView);

/** A list the Sort and view sheet configures. */
export const SortList = Schema.Literals(["albums", "songs"]);

/** A list the Sort and view sheet configures. */
export type SortList = typeof SortList.Type;

/** One choice in the sheet. */
interface SortOption<Sort extends string> {
  readonly value: Sort;
  readonly label: string;
}

/** What the sheet offers for one list. */
interface SortSheet<Sort extends string> {
  /** What the sheet's subtitle calls the list. */
  readonly subtitle: string;
  readonly sorts: ReadonlyArray<SortOption<Sort>>;
  /** Whether the list can switch between a grid and a list. */
  readonly layout: boolean;
}

/** What the sheet offers for each list. */
export const SORT_SHEETS = {
  albums: {
    subtitle: "Albums in your collection",
    sorts: [
      { value: "added", label: "Recently added" },
      { value: "title", label: "Title · A–Z" },
      { value: "artist", label: "Artist · A–Z" },
    ],
    layout: true,
  },
  songs: {
    subtitle: "Songs in your collection",
    sorts: [
      { value: "title", label: "Title · A–Z" },
      { value: "artist", label: "Artist · A–Z" },
    ],
    layout: false,
  },
} as const satisfies {
  readonly albums: SortSheet<AlbumSort>;
  readonly songs: SortSheet<SongSort>;
};

/** Sorting keys, compared in order; folded so case and accents don't split the alphabet. */
type SortKeys = readonly [string, string];

/** `items` ordered by `keys`, computed once per item. */
const orderBy = <Item>(
  items: ReadonlyArray<Item>,
  keys: (item: Item) => SortKeys,
): ReadonlyArray<Item> => {
  const keyed = items.map((item) => {
    const [first, second] = keys(item);

    return { item, first: foldSearchText(first), second: foldSearchText(second) };
  });

  // Sorted in place: `keyed` is this function's own copy, and Hermes has no `toSorted`.
  keyed.sort(
    (left, right) => compareText(left.first, right.first) || compareText(left.second, right.second),
  );

  return keyed.map(({ item }) => item);
};

/** Whether `sort` is the order the server pages albums in, so pages can show as they load. */
export const albumsArriveSorted = (sort: AlbumSort): boolean => sort === "added";

/** Whether `sort` is the order the server pages songs in. */
export const songsArriveSorted = (sort: SongSort): boolean => sort === "title";

/** Albums in `sort` order; newest first is the server's own. */
export const sortAlbums = (
  albums: ReadonlyArray<AlbumCard>,
  sort: AlbumSort,
): ReadonlyArray<AlbumCard> => {
  if (sort === "added") return albums;

  return orderBy(albums, (album) =>
    sort === "title" ? [album.title, album.artist] : [album.artist, album.title],
  );
};

/** Songs in `sort` order; by title is the server's own. */
export const sortSongs = (tracks: ReadonlyArray<Track>, sort: SongSort): ReadonlyArray<Track> => {
  if (sort === "title") return tracks;

  return orderBy(tracks, (track) => [track.artist, track.title]);
};
