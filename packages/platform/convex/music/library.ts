import { register } from "../../commands/music/library";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { reachOf } from "../core/permissions/grants";
import type { ItemGate } from "../core/permissions/grants";
import { callBudget, plus, readsOf, settleRead, times } from "../movies/reads";
import type { ReadBudget, Reads } from "../movies/reads";
import { ALBUM_FACTS, budgetedGates, walkMusicLibraries } from "./access";
import { foldSearchText } from "./catalog";
import { trackFacts } from "./items";
import { ARTIST_ART_ALBUMS, artistArt, likedAmong, musicPresenter } from "./present";
import { LIKED_READS, getsOf, rowsOf } from "./reads";
import { totalsOf } from "./totals";
import type { Totals } from "./totals";

/** Albums each home row shows, as old music's did. */
const HOME_ROW = 12;

/**
 * Newest albums read from each library for the recently added row: a few more than the row, so
 * albums whose songs all went missing leave it full.
 */
const NEWEST_PER_LIBRARY = HOME_ROW + 4;

/** Plays the recently played rows are taken from, as old music read them. */
const RECENT_PLAYS = 100;

/** A library's totals: four counters of at most 16 shards each. */
const TOTALS_READS = readsOf(4, 64);

/** Results of each kind a search answers when it names no limit, and at most. */
const SEARCH_DEFAULT = 20;

const SEARCH_MAX = 50;

/** The longest search old music took. */
const QUERY_MAX = 200;

/** What an artist's artwork fallback reads. */
const ARTIST_ART_READS = rowsOf("albums", ARTIST_ART_ALBUMS);

/** Reads `count` docs with `read` when `budget` pays for `cost`, and settles it on what came back. */
const paid = async <Row extends Parameters<typeof settleRead>[2][number]>(
  budget: ReadBudget,
  cost: Reads,
  read: () => Promise<ReadonlyArray<Row>>,
): Promise<ReadonlyArray<Row> | null> => {
  if (!budget.take(cost)) return null;

  const rows = await read();

  settleRead(budget, cost, rows);

  return rows;
};

const newestOf = async (
  db: DatabaseReader,
  budget: ReadBudget,
  gate: ItemGate,
): Promise<ReadonlyArray<Doc<"albums">>> =>
  (await paid(budget, rowsOf("albums", NEWEST_PER_LIBRARY), async () =>
    db
      .query("albums")
      .withIndex("by_library_added", (q) => q.eq("libraryId", gate.library._id))
      .order("desc")
      .take(NEWEST_PER_LIBRARY),
  )) ?? [];

const byNewest = (left: Doc<"albums">, right: Doc<"albums">): number =>
  right.addedAt - left.addedAt || (right.tie < left.tie ? -1 : 1);

const sumTotals = (all: ReadonlyArray<Totals>): Totals =>
  all.reduce(
    (sum, one) => ({
      tracks: sum.tracks + one.tracks,
      albums: sum.albums + one.albums,
      artists: sum.artists + one.artists,
      durationMs: sum.durationMs + one.durationMs,
    }),
    { tracks: 0, albums: 0, artists: 0, durationMs: 0 },
  );

const firstDistinct = <Key>(keys: ReadonlyArray<Key>, count: number): ReadonlyArray<Key> =>
  [...new Set(keys)].slice(0, count);

/** The caller's recently played albums and their artists, newest play first. */
const recentlyPlayed = async (
  db: DatabaseReader,
  userId: Id<"users">,
  budget: ReadBudget,
  sees: (albumLibrary: Id<"libraries">) => Promise<boolean>,
): Promise<{
  readonly albums: ReadonlyArray<Doc<"albums">>;
  readonly artists: ReadonlyArray<Doc<"artists">>;
}> => {
  const plays =
    (await paid(budget, rowsOf("plays", RECENT_PLAYS), async () =>
      db
        .query("plays")
        .withIndex("by_user_played", (q) => q.eq("userId", userId))
        .order("desc")
        .take(RECENT_PLAYS),
    )) ?? [];

  const albumIds = firstDistinct(
    plays.map((play) => play.albumId),
    HOME_ROW,
  );

  const found =
    (await paid(budget, getsOf("albums", albumIds.length), async () =>
      Promise.all(albumIds.map(async (albumId) => db.get(albumId))),
    )) ?? [];

  const visible = await Promise.all(
    found.map(async (album) =>
      album !== null && album.trackCount > 0 && (await sees(album.libraryId)) ? [album] : [],
    ),
  );

  const albums = visible.flat();

  const artistIds = firstDistinct(
    albums.map((album) => album.artistId),
    HOME_ROW,
  );

  const artists =
    (await paid(budget, getsOf("artists", artistIds.length), async () =>
      Promise.all(artistIds.map(async (artistId) => db.get(artistId))),
    )) ?? [];

  return { albums, artists: artists.filter((artist) => artist !== null) };
};

/** One library's matches for a folded search, or null once the budget cannot pay for them. */
const searchLibrary = async (
  db: DatabaseReader,
  budget: ReadBudget,
  gate: ItemGate,
  text: string,
  limit: number,
) => {
  const libraryId = gate.library._id;

  const trackCost = rowsOf("tracks", limit);
  const albumCost = rowsOf("albums", limit);
  const artistCost = rowsOf("artists", limit);

  if (!budget.take(plus(plus(trackCost, albumCost), artistCost))) return null;

  const [tracks, albums, artists] = await Promise.all([
    db
      .query("tracks")
      .withSearchIndex("search_text", (q) =>
        q.search("searchText", text).eq("libraryId", libraryId).eq("missing", false),
      )
      .take(limit),
    db
      .query("albums")
      .withSearchIndex("search_text", (q) =>
        q.search("searchText", text).eq("libraryId", libraryId),
      )
      .take(limit),
    db
      .query("artists")
      .withSearchIndex("search_text", (q) =>
        q.search("searchText", text).eq("libraryId", libraryId),
      )
      .take(limit),
  ]);

  settleRead(budget, trackCost, tracks);
  settleRead(budget, albumCost, albums);
  settleRead(budget, artistCost, artists);

  return {
    tracks: tracks.filter((track) => gate.admits(trackFacts(track))),
    albums: albums.filter((album) => album.trackCount > 0),
    artists: artists.filter((artist) => artist.albumCount > 0),
  };
};

const searchLimit = (limit: number | undefined): number => {
  if (limit === undefined) return SEARCH_DEFAULT;

  return Number.isInteger(limit) && limit >= 1 && limit <= SEARCH_MAX
    ? limit
    : fail("invalid_args", `Ask for 1 to ${SEARCH_MAX} results of each kind`);
};

export const { home, search } = register({
  home: async (ctx, _args, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const budget = callBudget(reach);
    const { gates } = await walkMusicLibraries(ctx.db, reach, budget.part(0.25));

    const totals = await Promise.all(
      gates.map(async (gate) =>
        budget.take(TOTALS_READS) ? [await totalsOf(ctx.db, gate.library._id)] : [],
      ),
    );

    const newest = await Promise.all(gates.map(async (gate) => newestOf(ctx.db, budget, gate)));

    const recentlyAdded = newest
      .flat()
      .filter((album) => album.trackCount > 0)
      .toSorted(byNewest)
      .slice(0, HOME_ROW);

    const played = budgetedGates(ctx.db, reach, "view", budget);

    const recent = await recentlyPlayed(ctx.db, caller.userId, budget, async (libraryId) => {
      const gate = await played(libraryId);

      return gate?.admits(ALBUM_FACTS) === true;
    });

    const present = musicPresenter();

    const artists = await Promise.all(
      recent.artists.map(async (artist) =>
        budget.take(ARTIST_ART_READS)
          ? present.artist(artist, await artistArt(ctx.db, artist))
          : present.artist(artist, artist.artHash),
      ),
    );

    return {
      recentlyAdded: await Promise.all(recentlyAdded.map(async (album) => present.album(album))),
      recentlyPlayed: await Promise.all(recent.albums.map(async (album) => present.album(album))),
      recentlyPlayedArtists: artists,
      stats: sumTotals(totals.flat()),
    };
  },
  search: async (ctx, args, caller) => {
    const limit = searchLimit(args.limit);

    if (args.query.length > QUERY_MAX) {
      return fail("invalid_args", `Search with at most ${QUERY_MAX} characters`);
    }

    const text = foldSearchText(args.query).trim();

    if (text.length === 0) return { tracks: [], albums: [], artists: [] };

    const reach = await reachOf(ctx.db, caller);
    const budget = callBudget(reach);
    const { gates } = await walkMusicLibraries(ctx.db, reach, budget.part(0.25));

    const found = (
      await Promise.all(gates.map(async (gate) => searchLibrary(ctx.db, budget, gate, text, limit)))
    ).filter((matches) => matches !== null);

    const tracks = found.flatMap((matches) => matches.tracks).slice(0, limit);
    const albums = found.flatMap((matches) => matches.albums).slice(0, limit);
    const artists = found.flatMap((matches) => matches.artists).slice(0, limit);

    const liked = budget.take(times(LIKED_READS, tracks.length))
      ? await likedAmong(
          ctx.db,
          caller.userId,
          tracks.map((track) => track._id),
        )
      : new Set<Id<"tracks">>();

    const present = musicPresenter();

    return {
      tracks: await Promise.all(
        tracks.map(async (track) => present.track(track, liked.has(track._id))),
      ),
      albums: await Promise.all(albums.map(async (album) => present.album(album))),
      artists: await Promise.all(
        artists.map(async (artist) =>
          budget.take(ARTIST_ART_READS)
            ? present.artist(artist, await artistArt(ctx.db, artist))
            : present.artist(artist, artist.artHash),
        ),
      ),
    };
  },
});
