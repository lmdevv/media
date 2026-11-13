import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { visiblePage } from "../core/permissions/grants";
import type { Reach } from "../core/permissions/grants";
import { CALL_COST, addCost, cost } from "./budget";
import type { Cost } from "./budget";
import { DOCUMENT_BYTES, TABLE_BYTES } from "./fit";
import type { Decider } from "./person";
import type { MusicStore } from "./write";

/**
 * Autoplay, as old music's `autoplaySongs` picked: when a queue runs out, songs by the same
 * artist, then albums of the same genre around the same year, then albums from around the same
 * year, leaving out songs already queued or recently played. Old music read up to 300 songs of an
 * artist and 24 albums a step; this reads fewer, so a queue command that tops the queue up stays
 * well inside Convex's limits, and each step runs only while the call can still pay for it.
 */

/** Songs autoplay adds each time the queue runs out. */
export const AUTOPLAY_BATCH = 10;

/** The person's plays whose songs autoplay leaves out. */
const RECENT_PLAYS = 100;

/** Artists sharing the seed artist's name across libraries, as old music read them. */
const ARTIST_ENTRIES = 12;

/** Songs read across those artists. */
const SONGS_PER_ARTIST = 60;

/** Albums one genre or era step reads, half in the seed's library. */
const ALBUMS_PER_STEP = 12;

/** Songs read from each of those albums. */
const SONGS_PER_ALBUM = 10;

/** Libraries a step reads besides the seed's, as old music's `stepLibraries` chose them. */
const OTHER_LIBRARIES = 12;

/** How many years either side of the seed's album counts as around the same time. */
const YEAR_RANGE = 2;

/** Fisher-Yates shuffle into a new array. */
export const shuffled = <Item>(items: ReadonlyArray<Item>): Array<Item> => {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    const current = result[index];
    const swap = result[other];

    if (current === undefined || swap === undefined) continue;

    result[index] = swap;
    result[other] = current;
  }

  return result;
};

const tracksCost = (tracks: number, ranges: number): Cost =>
  cost(ranges, 0, tracks * TABLE_BYTES.tracks);

/** What one step may read at worst, besides deciding its songs' libraries. */
const ARTIST_STEP = addCost(
  cost(2, 0, (1 + ARTIST_ENTRIES) * TABLE_BYTES.artists),
  tracksCost(SONGS_PER_ARTIST, ARTIST_ENTRIES),
);

const ALBUM_STEP = addCost(
  cost(2 * (1 + OTHER_LIBRARIES), 0, ALBUMS_PER_STEP * TABLE_BYTES.albums),
  tracksCost(ALBUMS_PER_STEP * SONGS_PER_ALBUM, ALBUMS_PER_STEP),
);

const within = (spent: Cost, limit: Cost): boolean =>
  spent.work.ranges <= limit.work.ranges && spent.readBytes <= limit.readBytes;

const share = (total: number, parts: number): number =>
  Math.max(1, Math.floor(total / Math.max(1, parts)));

/** What autoplay reads besides the store's charged reads: the caller's first page of libraries. */
const librariesCost = (reach: Reach): Cost => {
  const keys = reach.direct.length + reach.groups.length;

  return cost(
    keys + 1 + OTHER_LIBRARIES,
    0,
    (keys + 1) * (OTHER_LIBRARIES + 2) * DOCUMENT_BYTES.small,
  );
};

interface Picking {
  readonly store: MusicStore;
  readonly decider: Decider;
  readonly excluded: ReadonlySet<Id<"tracks">>;
  /** What the rest of the call still needs after picking, kept out of every step. */
  readonly reserve: Cost;
}

/** Whether the call can still pay for a step of `most` and each of `songs` decided. */
const affords = (picking: Picking, most: Cost, songs: number): boolean =>
  within(
    addCost(
      addCost(picking.store.meter.spent(), picking.reserve),
      addCost(
        most,
        cost(songs * picking.decider.most.work.ranges, 0, songs * picking.decider.most.readBytes),
      ),
    ),
    CALL_COST,
  );

const playable = async (
  picking: Picking,
  tracks: ReadonlyArray<Doc<"tracks">>,
): Promise<ReadonlyArray<Doc<"tracks">>> => {
  const kept = await Promise.all(
    tracks.map(async (track) =>
      !track.missing && !picking.excluded.has(track._id) && (await picking.decider.decide(track))
        ? [track]
        : [],
    ),
  );

  return kept.flat();
};

const sameArtist = async (
  picking: Picking,
  seed: Doc<"tracks">,
): Promise<ReadonlyArray<Doc<"tracks">>> => {
  const { store } = picking;
  const artist = await store.get("artists", seed.artistId);

  if (artist === null) return [];

  const sameName = await store.take(
    "artists",
    (q) => q.withIndex("by_key", (index) => index.eq("key", artist.key)),
    ARTIST_ENTRIES,
  );

  // The seed's own artist first: the first entries by name may all be in libraries the person
  // does not see.
  const entries = [artist, ...sameName.filter((entry) => entry._id !== artist._id)].slice(
    0,
    ARTIST_ENTRIES,
  );

  const perEntry = share(SONGS_PER_ARTIST, entries.length);

  const songs = await Promise.all(
    entries.map(async (entry) =>
      store.take(
        "tracks",
        (q) => q.withIndex("by_artist", (index) => index.eq("artistId", entry._id)),
        perEntry,
      ),
    ),
  );

  return playable(picking, songs.flat());
};

const songsOf = async (
  picking: Picking,
  albums: ReadonlyArray<Doc<"albums">>,
): Promise<ReadonlyArray<Doc<"tracks">>> => {
  const songs = await Promise.all(
    albums.map(async (album) =>
      picking.store.take(
        "tracks",
        (q) => q.withIndex("by_album", (index) => index.eq("albumId", album._id)),
        SONGS_PER_ALBUM,
      ),
    ),
  );

  return playable(picking, songs.flat());
};

/** The seed's library with half a step's albums, and the others sharing the rest. */
const stepLibraries = (
  seedLibrary: Id<"libraries">,
  others: ReadonlyArray<Id<"libraries">>,
): ReadonlyArray<{ readonly libraryId: Id<"libraries">; readonly albums: number }> => {
  const half = ALBUMS_PER_STEP / 2;
  const each = share(others.length === 0 ? 0 : half, others.length);

  return [
    { libraryId: seedLibrary, albums: others.length === 0 ? ALBUMS_PER_STEP : half },
    ...others.map((libraryId) => ({ libraryId, albums: each })),
  ];
};

const sameGenre = async (
  picking: Picking,
  album: Doc<"albums">,
  libraries: ReturnType<typeof stepLibraries>,
): Promise<ReadonlyArray<Doc<"tracks">>> => {
  const { genre, year } = album;

  if (genre === null) return [];

  const albums = await Promise.all(
    libraries.map(async ({ libraryId, albums: count }) => {
      if (year === null) {
        return picking.store.take(
          "albums",
          (q) =>
            q.withIndex("by_library_genre", (index) =>
              index.eq("libraryId", libraryId).eq("genre", genre),
            ),
          count,
        );
      }

      const half = Math.ceil(count / 2);

      const [later, earlier] = await Promise.all([
        picking.store.take(
          "albums",
          (q) =>
            q.withIndex("by_library_genre", (index) =>
              index.eq("libraryId", libraryId).eq("genre", genre).gte("year", year),
            ),
          half,
        ),
        picking.store.take(
          "albums",
          (q) =>
            q
              .withIndex("by_library_genre", (index) =>
                index.eq("libraryId", libraryId).eq("genre", genre).lt("year", year),
              )
              .order("desc"),
          half,
        ),
      ]);

      return [...later, ...earlier].slice(0, count);
    }),
  );

  return songsOf(picking, albums.flat());
};

const sameEra = async (
  picking: Picking,
  album: Doc<"albums">,
  libraries: ReturnType<typeof stepLibraries>,
): Promise<ReadonlyArray<Doc<"tracks">>> => {
  const { year } = album;

  if (year === null) return [];

  const albums = await Promise.all(
    libraries.map(async ({ libraryId, albums: count }) =>
      picking.store.take(
        "albums",
        (q) =>
          q.withIndex("by_library_year", (index) =>
            index
              .eq("libraryId", libraryId)
              .gte("year", year - YEAR_RANGE)
              .lte("year", year + YEAR_RANGE),
          ),
        count,
      ),
    ),
  );

  return songsOf(picking, albums.flat());
};

/** Up to 12 other music libraries the person sees, from the first page of their grants. */
const otherLibraries = async (
  db: DatabaseReader,
  reach: Reach,
  seedLibrary: Id<"libraries">,
): Promise<ReadonlyArray<Id<"libraries">>> => {
  const page = await visiblePage({ db }, reach.principal, "library", {
    numItems: OTHER_LIBRARIES + 1,
    cursor: null,
  });

  return page.page
    .filter(({ doc }) => doc.kind === "music" && doc._id !== seedLibrary)
    .map(({ doc }) => doc._id)
    .slice(0, OTHER_LIBRARIES);
};

/**
 * Up to `AUTOPLAY_BATCH` songs to play after `seed`, each one the person may play, none of
 * `queued` and none of their recent plays. Steps after the first run only when the earlier ones
 * came up short and the call can still pay for them, leaving `reserve` for the rest of the call.
 */
export const autoplaySongs = async (
  db: DatabaseReader,
  store: MusicStore,
  reach: Reach,
  decider: Decider,
  seed: Doc<"tracks">,
  queued: ReadonlyArray<Id<"tracks">>,
  reserve: Cost,
): Promise<ReadonlyArray<Id<"tracks">>> => {
  const recent = await store.take(
    "plays",
    (q) =>
      q
        .withIndex("by_user_played", (index) => index.eq("userId", reach.principal.userId))
        .order("desc"),
    RECENT_PLAYS,
  );

  const picking: Picking = {
    store,
    decider,
    excluded: new Set([seed._id, ...queued, ...recent.map((play) => play.trackId)]),
    reserve,
  };

  /** The seed's album and the libraries the genre and era steps read, loaded once. */
  let context: Promise<{
    readonly album: Doc<"albums">;
    readonly libraries: ReturnType<typeof stepLibraries>;
  } | null> | null = null;

  const albumContext = async () => {
    context ??= (async () => {
      const album = await store.get("albums", seed.albumId);

      if (album === null) return null;

      store.meter.charge(librariesCost(reach));

      return {
        album,
        libraries: stepLibraries(album.libraryId, await otherLibraries(db, reach, album.libraryId)),
      };
    })();

    return context;
  };

  const albumSongs =
    (step: typeof sameGenre): (() => Promise<ReadonlyArray<Doc<"tracks">>>) =>
    async () => {
      const found = await albumContext();

      return found === null ? [] : step(picking, found.album, found.libraries);
    };

  const steps: ReadonlyArray<{
    readonly most: Cost;
    readonly songs: number;
    readonly run: () => Promise<ReadonlyArray<Doc<"tracks">>>;
  }> = [
    { most: ARTIST_STEP, songs: SONGS_PER_ARTIST, run: async () => sameArtist(picking, seed) },
    {
      most: addCost(ALBUM_STEP, librariesCost(reach)),
      songs: ALBUMS_PER_STEP * SONGS_PER_ALBUM,
      run: albumSongs(sameGenre),
    },
    {
      most: addCost(ALBUM_STEP, librariesCost(reach)),
      songs: ALBUMS_PER_STEP * SONGS_PER_ALBUM,
      run: albumSongs(sameEra),
    },
  ];

  const pick = async (
    remaining: typeof steps,
    picked: ReadonlyArray<Id<"tracks">>,
  ): Promise<ReadonlyArray<Id<"tracks">>> => {
    const [step, ...rest] = remaining;

    if (step === undefined || picked.length >= AUTOPLAY_BATCH) return picked;

    if (!affords(picking, step.most, step.songs)) return picked;

    const taken = new Set(picked);

    const fresh = shuffled(await step.run())
      .map((track) => track._id)
      .filter((id) => {
        if (taken.has(id)) return false;

        taken.add(id);

        return true;
      });

    return pick(rest, [...picked, ...fresh].slice(0, AUTOPLAY_BATCH));
  };

  return pick(steps, []);
};
