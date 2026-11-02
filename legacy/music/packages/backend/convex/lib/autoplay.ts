import { shuffled } from "@music/commands/queue-rules";

import type { Doc, Id } from "../_generated/dataModel";
import { canRead } from "./viewer";
import type { ReadCtx, Viewer } from "./viewer";

/** Songs autoplay adds each time the queue runs out. */
export const AUTOPLAY_BATCH = 10;

const RECENT_PLAYS = 100;

const ALBUMS_PER_STEP = 24;

const ARTIST_ENTRIES = 12;

const SONGS_PER_ARTIST = 300;

const SONGS_PER_ALBUM = 25;

const share = (budget: number, parts: number): number =>
  Math.max(1, Math.floor(budget / Math.max(1, parts)));

interface StepLibrary {
  readonly library: Doc<"libraries">;
  readonly albums: number;
}

const stepLibraries = (
  viewer: Viewer,
  seedLibraryId: Id<"libraries"> | undefined,
): ReadonlyArray<StepLibrary> => {
  const seed = viewer.libraries.find((library) => library._id === seedLibraryId);
  const others = viewer.libraries.filter((library) => library._id !== seedLibraryId);
  const half = ALBUMS_PER_STEP / 2;
  const othersBudget = seed === undefined ? ALBUMS_PER_STEP : half;
  const chosen = others.slice(0, othersBudget);
  const each = share(othersBudget, chosen.length);

  const seedEntry: ReadonlyArray<StepLibrary> =
    seed === undefined
      ? []
      : [{ library: seed, albums: chosen.length === 0 ? ALBUMS_PER_STEP : half }];

  return [...seedEntry, ...chosen.map((library) => ({ library, albums: each }))];
};

/** How many years either side of the seed's album counts as "around the same time". */
export const YEAR_RANGE = 2;

/** The songs autoplay may pick, before the step's own candidates. */
interface Picker {
  readonly viewer: Viewer;
  /** Songs to leave out: already queued or recently played. */
  readonly excluded: ReadonlySet<Id<"tracks">>;
}

const playable = (picker: Picker, track: Doc<"tracks">): boolean =>
  !track.missing && canRead(picker.viewer, track.libraryId) && !picker.excluded.has(track._id);

const songsOfAlbums = async (
  ctx: ReadCtx,
  picker: Picker,
  albums: ReadonlyArray<Doc<"albums">>,
): Promise<Array<Doc<"tracks">>> => {
  const readable = albums.filter((album) => canRead(picker.viewer, album.libraryId));

  const songs = await Promise.all(
    readable.map((album) =>
      ctx.db
        .query("tracks")
        .withIndex("by_album", (q) => q.eq("albumId", album._id))
        .take(SONGS_PER_ALBUM),
    ),
  );

  return songs.flat().filter((track) => playable(picker, track));
};

const sameArtist = async (
  ctx: ReadCtx,
  picker: Picker,
  seed: Doc<"tracks">,
): Promise<Array<Doc<"tracks">>> => {
  const artist = await ctx.db.get(seed.artistId);

  if (artist === null) return [];

  const entries = await ctx.db
    .query("artists")
    .withIndex("by_key", (q) => q.eq("key", artist.key))
    .take(ARTIST_ENTRIES);

  const readable = entries.filter((entry) => canRead(picker.viewer, entry.libraryId));
  const perEntry = share(SONGS_PER_ARTIST, readable.length);

  const songs = await Promise.all(
    readable.map((entry) =>
      ctx.db
        .query("tracks")
        .withIndex("by_artist", (q) => q.eq("artistId", entry._id))
        .take(perEntry),
    ),
  );

  return songs.flat().filter((track) => playable(picker, track));
};

const genreAlbums = async (
  ctx: ReadCtx,
  libraryId: Id<"libraries">,
  genre: string,
  year: number | undefined,
  count: number,
): Promise<Array<Doc<"albums">>> => {
  const half = Math.ceil(count / 2);

  if (year === undefined) {
    return ctx.db
      .query("albums")
      .withIndex("by_library_genre", (q) => q.eq("libraryId", libraryId).eq("genre", genre))
      .take(count);
  }

  const [later, earlier] = await Promise.all([
    ctx.db
      .query("albums")
      .withIndex("by_library_genre", (q) =>
        q.eq("libraryId", libraryId).eq("genre", genre).gte("year", year),
      )
      .take(half),
    ctx.db
      .query("albums")
      .withIndex("by_library_genre", (q) =>
        q.eq("libraryId", libraryId).eq("genre", genre).lt("year", year),
      )
      .order("desc")
      .take(half),
  ]);

  return [...later, ...earlier].slice(0, count);
};

const sameGenre = async (
  ctx: ReadCtx,
  picker: Picker,
  album: Doc<"albums"> | null,
): Promise<Array<Doc<"tracks">>> => {
  const genre = album?.genre;

  if (genre === undefined) return [];

  const albums = await Promise.all(
    stepLibraries(picker.viewer, album?.libraryId).map((step) =>
      genreAlbums(ctx, step.library._id, genre, album?.year, step.albums),
    ),
  );

  return songsOfAlbums(ctx, picker, albums.flat());
};

const sameEra = async (
  ctx: ReadCtx,
  picker: Picker,
  album: Doc<"albums"> | null,
): Promise<Array<Doc<"tracks">>> => {
  const year = album?.year;

  if (year === undefined) return [];

  const albums = await Promise.all(
    stepLibraries(picker.viewer, album?.libraryId).map((step) =>
      ctx.db
        .query("albums")
        .withIndex("by_library_year", (q) =>
          q
            .eq("libraryId", step.library._id)
            .gte("year", year - YEAR_RANGE)
            .lte("year", year + YEAR_RANGE),
        )
        .take(step.albums),
    ),
  );

  return songsOfAlbums(ctx, picker, albums.flat());
};

/**
 * Up to `count` songs to play after `seed`, following the rule above. `queued` are the songs
 * already in the queue. Steps after the first run only when the earlier ones came up short.
 */
export const autoplaySongs = async (
  ctx: ReadCtx,
  viewer: Viewer,
  seed: Doc<"tracks">,
  queued: ReadonlyArray<Id<"tracks">>,
  count: number = AUTOPLAY_BATCH,
): Promise<Array<Id<"tracks">>> => {
  const recent = await ctx.db
    .query("history")
    .withIndex("by_user", (q) => q.eq("userId", viewer.id))
    .order("desc")
    .take(RECENT_PLAYS);

  const excluded = new Set([seed._id, ...queued, ...recent.map((play) => play.trackId)]);
  const picker: Picker = { viewer, excluded };
  const album = await ctx.db.get(seed.albumId);

  const steps = [
    () => sameArtist(ctx, picker, seed),
    () => sameGenre(ctx, picker, album),
    () => sameEra(ctx, picker, album),
  ];

  const pick = async (
    remaining: ReadonlyArray<() => Promise<Array<Doc<"tracks">>>>,
    picked: ReadonlyArray<Id<"tracks">>,
  ): Promise<Array<Id<"tracks">>> => {
    const [step, ...rest] = remaining;

    if (step === undefined || picked.length >= count) return [...picked];
    const taken = new Set(picked);

    const fresh = shuffled(await step(), Math.random)
      .map((track) => track._id)
      .filter((id) => {
        if (taken.has(id)) return false;
        taken.add(id);

        return true;
      });

    return pick(rest, [...picked, ...fresh].slice(0, count));
  };

  return pick(steps, []);
};
