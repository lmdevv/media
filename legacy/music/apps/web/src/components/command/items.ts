import type { FieldSpec } from "@music/commands/forms";
import type {
  AlbumCard as Album,
  ArtistCard as Artist,
  Playlist,
  SearchResults,
  Track,
} from "@music/commands/models";
import { commands } from "@music/commands/registry";
import type { CommandName, MutationName } from "@music/commands/registry";
import { foldSearchText } from "@music/commands/search-text";
import type { LucideIcon } from "lucide-react";

/**
 * One row in the command menu: the song playing, a library record, a registry command, or a
 * built-in action. `id` is unique across the list; `section` is the header the row sits under.
 */
export type Item =
  | { readonly kind: "now"; readonly id: string; readonly section: string; readonly track: Track }
  | { readonly kind: "album"; readonly id: string; readonly section: string; readonly album: Album }
  | {
      readonly kind: "artist";
      readonly id: string;
      readonly section: string;
      readonly artist: Artist;
    }
  | {
      readonly kind: "track";
      readonly id: string;
      readonly section: string;
      readonly track: Track;
      readonly tracks: ReadonlyArray<Track>;
    }
  | {
      readonly kind: "playlist";
      readonly id: string;
      readonly section: string;
      readonly playlist: Playlist;
    }
  | {
      readonly kind: "command";
      readonly id: string;
      readonly section: string;
      readonly name: MutationName;
      readonly fields: ReadonlyArray<FieldSpec>;
    }
  | {
      readonly kind: "action";
      readonly id: string;
      readonly section: string;
      readonly title: string;
      readonly detail: string;
      readonly icon: LucideIcon;
      readonly shortcut?: string;
      readonly label: string;
      readonly run: () => void;
    };

/** `playlists.create` → `music playlists create`, the CLI spelling of a command. */
export const cliOf = (name: CommandName): string => `music ${name.split(".").join(" ")}`;

/** The row's main line: the record's name, the command's summary, or the action's title. */
export const titleOf = (item: Item): string => {
  switch (item.kind) {
    case "now":
    case "track":
      return item.track.title;
    case "album":
      return item.album.title;
    case "artist":
      return item.artist.name;
    case "playlist":
      return item.playlist.name;
    case "command":
      return commands[item.name].summary;
    case "action":
      return item.title;
    default:
      return "";
  }
};

const keywordsOf = (item: Item): string => {
  switch (item.kind) {
    case "command":
      return `${item.name} ${commands[item.name].group} ${cliOf(item.name)}`;
    case "action":
      return item.detail;
    case "now":
    case "album":
    case "artist":
    case "track":
    case "playlist":
      return "";
  }

  return "";
};

/** Ranks how well `query` matches: whole-title prefix, then a word prefix, then anywhere. */
const score = (item: Item, query: string): number => {
  const title = titleOf(item).toLowerCase();

  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  const haystack = `${title} ${keywordsOf(item).toLowerCase()}`;

  if (!words.every((word) => haystack.includes(word))) return 0;

  if (title.startsWith(query.toLowerCase())) return 3;

  return title.split(/\s+/).some((word) => words.some((part) => word.startsWith(part))) ? 2 : 1;
};

/**
 * What Enter does to the row, as the footer names it.
 *
 * @param playing - Whether something is playing now, which turns "Resume" into "Pause".
 */
export const primaryLabel = (item: Item, playing: boolean): string => {
  switch (item.kind) {
    case "now":
      return playing ? "Pause" : "Resume";
    case "album":
      return "Play album";
    case "artist":
      return "Play artist";
    case "track":
      return "Play";
    case "playlist":
      return "Open playlist";
    case "command":
      return "Run";
    case "action":
      return item.label;
    default:
      return "Open";
  }
};

/**
 * The rows before anything is typed: the song playing, two recent playlists and albums, then
 * every action and command.
 */
export const browseItems = ({
  track,
  playlists,
  recentlyPlayed,
  actions,
}: {
  readonly track: Track | null;
  readonly playlists: ReadonlyArray<Playlist>;
  readonly recentlyPlayed: ReadonlyArray<Album>;
  readonly actions: ReadonlyArray<Item>;
}): ReadonlyArray<Item> => {
  const now: Array<Item> =
    track === null ? [] : [{ kind: "now", id: "now", section: "Now playing", track }];

  const recent: Array<Item> = [
    ...playlists.slice(0, 2).map((playlist): Item => ({
      kind: "playlist",
      id: `pl-${playlist.id}`,
      section: "Recent",
      playlist,
    })),
    ...recentlyPlayed.slice(0, 2).map((album): Item => ({
      kind: "album",
      id: `al-${album.id}`,
      section: "Recent",
      album,
    })),
  ];

  return [...now, ...recent, ...actions];
};

/**
 * The rows for a typed query: top library results (none while `results` is still loading), then
 * the actions and commands that match, best match first.
 *
 * @param query - The trimmed query, which must not be empty.
 */
export const searchItems = ({
  query,
  results,
  playlists,
  actions,
}: {
  readonly query: string;
  readonly results: SearchResults | undefined;
  readonly playlists: ReadonlyArray<Playlist>;
  readonly actions: ReadonlyArray<Item>;
}): ReadonlyArray<Item> => {
  const folded = foldSearchText(query);

  const library: Array<Item> =
    results === undefined
      ? []
      : [
          ...results.artists.slice(0, 2).map((artist): Item => ({
            kind: "artist",
            id: `ar-${artist.id}`,
            section: "Top results",
            artist,
          })),
          ...results.albums.slice(0, 3).map((album): Item => ({
            kind: "album",
            id: `al-${album.id}`,
            section: "Top results",
            album,
          })),
          ...results.tracks.slice(0, 4).map((track): Item => ({
            kind: "track",
            id: `tr-${track.id}`,
            section: "Top results",
            track,
            tracks: results.tracks,
          })),
          ...playlists
            .filter((playlist) => foldSearchText(playlist.name).includes(folded))
            .slice(0, 2)
            .map((playlist): Item => ({
              kind: "playlist",
              id: `pl-${playlist.id}`,
              section: "Top results",
              playlist,
            })),
        ];

  const matched = actions
    .map((item) => ({ item, rank: score(item, query) }))
    .filter((entry) => entry.rank > 0)
    .toSorted((left, right) => right.rank - left.rank)
    .map((entry) => entry.item);

  return [...library, ...matched];
};
