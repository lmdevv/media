import { useAllPages, useFirstRows } from "@media/mobile-core/pages";
import type { PagedQuery, PageOpts, Paged } from "@media/mobile-core/pages";
import { useMemo } from "react";

import type {
  AlbumDetail,
  AlbumId,
  ArtistDetail,
  ArtistId,
  HistoryEntry,
  PlaylistDetail,
  PlaylistId,
} from "./models";
import { useMusic, useReadSettled } from "./platform";

const PAGE_ROWS = 100;

const wholeOf = <Row>(paged: Paged<Row>): ReadonlyArray<Row> | Error | undefined => {
  if (paged.status === "failed") return new Error(paged.message);

  if (paged.status !== "ready") return undefined;

  if (paged.next.kind === "failed") return new Error(paged.next.message);

  return paged.next.kind === "done" ? paged.rows : undefined;
};

const joined = <A, Row, B>(
  record: A | Error | undefined,
  rows: ReadonlyArray<Row> | Error | undefined,
  join: (record: A, rows: ReadonlyArray<Row>) => B,
): B | Error | undefined => {
  if (record instanceof Error) return record;

  if (rows instanceof Error) return rows;

  return record === undefined || rows === undefined ? undefined : join(record, rows);
};

const useRows = <Args, Row>(
  query: PagedQuery<Args, Row>,
  argsAt: ((paginationOpts: PageOpts) => Args) | "skip",
): ReadonlyArray<Row> | Error | undefined => wholeOf(useAllPages(query, argsAt, PAGE_ROWS));

/**
 * An album and every one of its songs; an `Error` for a failure, undefined while it loads. Pass
 * `"skip"` to wait.
 */
export const useAlbumDetail = (albumId: AlbumId | "skip"): AlbumDetail | Error | undefined => {
  const music = useMusic();
  const facts = useReadSettled(music.albums.get, albumId === "skip" ? "skip" : { albumId });

  const tracks = useRows(
    music.albums.tracks,
    albumId === "skip" ? "skip" : (paginationOpts) => ({ albumId, paginationOpts }),
  );

  return useMemo(
    () => joined(facts, tracks, (album, rows) => ({ ...album, tracks: rows })),
    [facts, tracks],
  );
};

/** An artist with every album and their top songs. */
export const useArtistDetail = (artistId: ArtistId): ArtistDetail | Error | undefined => {
  const music = useMusic();
  const artist = useReadSettled(music.artists.get, { artistId });

  const albums = useRows(music.artists.albums, (paginationOpts) => ({ artistId, paginationOpts }));

  return useMemo(
    () =>
      joined(artist, albums, (found, rows) => ({
        artist: found.artist,
        topTracks: found.topTracks,
        albums: rows,
      })),
    [artist, albums],
  );
};

/** A playlist with every entry. */
export const usePlaylistDetail = (playlistId: PlaylistId): PlaylistDetail | Error | undefined => {
  const music = useMusic();
  const playlist = useReadSettled(music.playlists.get, { playlistId });

  const items = useRows(music.playlists.items, (paginationOpts) => ({
    playlistId,
    paginationOpts,
  }));

  return useMemo(
    () => joined(playlist, items, (found, rows) => ({ playlist: found, items: rows })),
    [playlist, items],
  );
};

/**
 * Your latest plays, newest first, up to `count`; undefined while they load. A failed page throws
 * to the route's error screen.
 */
export const useHistory = (count: number): ReadonlyArray<HistoryEntry> | undefined => {
  const music = useMusic();

  const paged = useFirstRows(
    music.history.list,
    (paginationOpts) => ({ paginationOpts }),
    count,
    count,
  );

  if (paged.status === "failed") throw new Error(paged.message);

  if (paged.status !== "ready") return undefined;

  if (paged.rows.length < count && paged.next.kind !== "done") {
    if (paged.next.kind === "failed") throw new Error(paged.next.message);

    return undefined;
  }

  return paged.rows.slice(0, count);
};

/**
 * Reads a paginated music query once, page after page, until it ends or holds `max` rows. Each
 * request needs the previous page's cursor, so pages load one after another.
 */
export const readPages = async <Row>(
  read: (paginationOpts: PageOpts) => Promise<{
    readonly page: ReadonlyArray<Row>;
    readonly isDone: boolean;
    readonly continueCursor: string;
  }>,
  max: number,
): Promise<ReadonlyArray<Row>> => {
  const collect = async (
    cursor: string | null,
    loaded: ReadonlyArray<Row>,
  ): Promise<ReadonlyArray<Row>> => {
    const page = await read({ numItems: PAGE_ROWS, cursor });

    if (!page.isDone && page.continueCursor === cursor) {
      throw new Error("The list stopped advancing; load it again");
    }

    const rows = [...loaded, ...page.page];

    return page.isDone || rows.length >= max
      ? rows.slice(0, max)
      : collect(page.continueCursor, rows);
  };

  return collect(null, []);
};

/**
 * The first rows of a paginated music query, up to `count`, and whether they are all of them;
 * undefined while they load. A failed page throws to the route's error screen.
 */
export const useFirstOf = <Args, Row>(
  query: PagedQuery<Args, Row>,
  argsAt: (paginationOpts: PageOpts) => Args,
  count: number,
): { readonly rows: ReadonlyArray<Row>; readonly done: boolean } | undefined => {
  const paged = useFirstRows(query, argsAt, count, count);

  if (paged.status === "failed") throw new Error(paged.message);

  if (paged.status !== "ready") return undefined;

  if (paged.next.kind === "failed") throw new Error(paged.next.message);

  if (paged.rows.length < count && paged.next.kind !== "done") return undefined;

  return {
    rows: paged.rows.slice(0, count),
    done: paged.next.kind === "done" && paged.rows.length <= count,
  };
};
