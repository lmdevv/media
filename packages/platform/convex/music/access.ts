import type { DomainItem, Level } from "../../commands/access";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { PAGE_ROWS_MAX } from "../core/lib/paginate";
import { levelOn, requireContent, visiblePage } from "../core/permissions/grants";
import type { ItemGate, Reach, Visible } from "../core/permissions/grants";
import { playableBy } from "../core/permissions/items";
import { can, contentNeeds, itemOf, resourceOf } from "../core/permissions/policy";
import type { ContentAction, ContentFacts, Principal } from "../core/permissions/policy";
import { readsOf } from "../movies/reads";
import type { ReadBudget } from "../movies/reads";
import { trackFacts } from "./items";

/** An album's facts: an album is never explicit itself; each of its tracks is decided on its own. */
export const ALBUM_FACTS: ContentFacts = { domain: "music", explicit: false };

const gateFor = (
  caller: Principal,
  action: ContentAction,
  library: Doc<"libraries">,
  level: Level | null,
): ItemGate | null =>
  library.kind !== "music" ||
  level === null ||
  !can(caller, action, resourceOf("library", library, level)).allowed
    ? null
    : {
        library,
        level,
        admits: (facts) => can(caller, action, itemOf(library, level, facts)).allowed,
      };

/**
 * Whether `caller` may do one action to rows of a library, decided once per library and call
 * through `can()`: null for a library that is gone, of another domain, or one they may not act on.
 */
export type Gates = (libraryId: Id<"libraries">) => Promise<ItemGate | null>;

/**
 * The `Gates` of one call for `action`. Each library's first decision reads it and its grants
 * (`libraryCheck`) and calls `first`, which charges that read where the call keeps its budget.
 */
export const libraryGates = (
  db: DatabaseReader,
  reach: Reach,
  action: ContentAction,
  first: () => void = () => undefined,
): Gates => {
  const gates = new Map<Id<"libraries">, Promise<ItemGate | null>>();

  return async (libraryId) => {
    const known = gates.get(libraryId);

    if (known !== undefined) return known;

    first();

    const gate = (async () => {
      const library = await db.get(libraryId);

      return library === null
        ? null
        : gateFor(
            reach.principal,
            action,
            library,
            await levelOn(db, reach, { type: "library", id: libraryId }),
          );
    })();

    gates.set(libraryId, gate);

    return gate;
  };
};

/**
 * Charges `budget` for each library a query decides, and answers null without reading once the
 * budget cannot pay for another, so a page or an aggregate stops there.
 */
export const budgetedGates = (
  db: DatabaseReader,
  reach: Reach,
  action: ContentAction,
  budget: ReadBudget,
): Gates => {
  const keys = reach.direct.length + reach.groups.length;
  const cost = readsOf(1 + keys, 1 + keys);
  const gates = libraryGates(db, reach, action);
  const decided = new Set<Id<"libraries">>();

  return async (libraryId) => {
    if (!decided.has(libraryId)) {
      if (!budget.take(cost)) return null;

      decided.add(libraryId);
    }

    return gates(libraryId);
  };
};

/** What a loader found and the gate `can()` decides the rest of its library's rows through. */
export interface InLibrary<Row> {
  readonly row: Row;
  readonly gate: ItemGate;
}

/**
 * Loads one catalog row and decides `action` on it through `can()` at its library's level with
 * `facts`: a row that is gone, in no music library, or one the caller may not see fails
 * `not_found` with `missing`; one they see but may not act on fails `forbidden`. Reads the row,
 * its library, and the library's grants for the caller's reach.
 */
const requireRow = async <Row extends { readonly libraryId: Id<"libraries"> }>(
  db: DatabaseReader,
  reach: Reach,
  action: ContentAction,
  row: Row | null,
  facts: (row: Row) => ContentFacts,
  missing: string,
): Promise<InLibrary<Row>> => {
  const library = row === null ? null : await db.get(row.libraryId);

  if (row === null || library === null || library.kind !== "music") {
    return fail("not_found", missing);
  }

  const level = await levelOn(db, reach, { type: "library", id: library._id });
  const caller = reach.principal;
  const decision = can(caller, action, itemOf(library, level, facts(row)));

  if (!decision.allowed) {
    if (decision.refusal === "hidden") return fail("not_found", missing);

    const needs = contentNeeds(action, "music");

    return fail(
      "forbidden",
      decision.because === "scope"
        ? `This session lacks the ${needs.scope} scope`
        : `This needs ${needs.level} access, and you have ${level ?? "none"}`,
    );
  }

  const gate = level === null ? null : gateFor(caller, action, library, level);

  return gate === null ? fail("not_found", missing) : { row, gate };
};

/** An album the caller may see, and its library's gate. Reads 2 and its library's grants. */
export const requireAlbum = async (
  db: DatabaseReader,
  reach: Reach,
  albumId: Id<"albums">,
): Promise<InLibrary<Doc<"albums">>> =>
  requireRow(db, reach, "view", await db.get(albumId), () => ALBUM_FACTS, "No such album");

/** An artist the caller may see, and its library's gate. Reads 2 and its library's grants. */
export const requireArtist = async (
  db: DatabaseReader,
  reach: Reach,
  artistId: Id<"artists">,
): Promise<InLibrary<Doc<"artists">>> =>
  requireRow(db, reach, "view", await db.get(artistId), () => ALBUM_FACTS, "No such artist");

/**
 * A track the caller may see, by its library's grants and its own facts, and its library's gate,
 * as old music's `links.get` found a song's album and title. Reads 2 and its library's grants.
 */
export const requireTrack = async (
  db: DatabaseReader,
  reach: Reach,
  trackId: Id<"tracks">,
): Promise<InLibrary<Doc<"tracks">>> =>
  requireRow(db, reach, "view", await db.get(trackId), trackFacts, "No such track");

/** A playlist the caller may do `action` to, and the level their grants give them on it. */
export const requirePlaylist = async (
  db: DatabaseReader,
  caller: Principal,
  action: ContentAction,
  playlistId: Id<"playlists">,
): Promise<Visible<"playlist">> =>
  requireContent({ db }, caller, action, { type: "playlist", id: playlistId });

/** The music libraries a walk found, and whether it reached the last library shared. */
export interface Walked {
  readonly gates: ReadonlyArray<ItemGate>;
  readonly complete: boolean;
}

/**
 * Every music library shared with the caller of `reach` that they may view, in id order, each
 * with the gate `can()` decides its rows through, as `walkMovieLibraries` walks movies' (ADR
 * 0005). It pages the caller's grants with `visiblePage`, as many rows a step as `visiblePage`'s
 * own sizing and `budget` allow, so movies libraries never push a music library out, and stops at
 * the last library or when `budget` cannot pay for another step, and says which.
 */
export const walkMusicLibraries = async (
  db: DatabaseReader,
  reach: Reach,
  budget: ReadBudget,
): Promise<Walked> => walkFrom(db, reach, budget, null, []);

const walkFrom = async (
  db: DatabaseReader,
  reach: Reach,
  budget: ReadBudget,
  cursor: string | null,
  found: ReadonlyArray<ItemGate>,
): Promise<Walked> => {
  const groups = reach.groups.length;
  const keys = reach.direct.length + groups;
  const room = budget.left();
  const fits = Math.floor((PAGE_ROWS_MAX - groups - keys) / (keys + 1));
  const documents = Math.min(room.documents, Math.floor(room.bytes / readsOf(0, 1).bytes));

  // Every grant key's range may return each row of the page and one more, and each row is read.
  const rows = Math.min(
    fits,
    room.ranges - 1 - keys,
    Math.floor((documents - groups) / (keys + 1)) - 1,
  );

  const step = readsOf(1 + keys + rows, groups + keys * (rows + 1) + rows);

  if (keys === 0 || rows < 1 || !budget.take(step)) {
    return { gates: found, complete: keys === 0 };
  }

  const page = await visiblePage({ db }, reach.principal, "library", { numItems: rows, cursor });

  const gates = [
    ...found,
    ...page.page.flatMap(({ doc, level }) => {
      const gate = gateFor(reach.principal, "view", doc, level);

      return gate === null ? [] : [gate];
    }),
  ];

  return page.isDone
    ? { gates, complete: true }
    : walkFrom(db, reach, budget, page.continueCursor, gates);
};

const trackItem = (track: Doc<"tracks">): DomainItem => ({
  domain: "music",
  ref: { type: "track", id: track._id },
});

const albumItem = (albumId: Id<"albums">): DomainItem => ({
  domain: "music",
  ref: { type: "album", id: albumId },
});

/** Whether the caller may play a track, decided once per library and call where it can be. */
export type TrackPlayer = (track: Doc<"tracks">) => Promise<boolean>;

/**
 * Decides `play` on tracks for the caller of `reach`, through `can()`. A person in the household
 * plays what their grants show them, with a kid's explicit filter applied to each track's facts. A
 * guest plays what their share link covers (ADR 0007): the track itself, or its album when their
 * link's maker may play the track, so a link to an album plays its songs, and never a song the
 * maker could not play. `first` is charged for each library a person's decision reads first.
 */
export const trackPlayer = (
  db: DatabaseReader,
  reach: Reach,
  first: () => void = () => undefined,
): TrackPlayer => {
  const { lent } = reach;

  if (lent === null) {
    const gates = libraryGates(db, reach, "play", first);

    return async (track) => (await gates(track.libraryId))?.admits(trackFacts(track)) ?? false;
  }

  const asGuest = playableBy(db, reach);
  const asMaker = playableBy(db, lent.maker);

  return async (track) =>
    (await asGuest(trackItem(track))) ||
    ((await asGuest(albumItem(track.albumId))) && (await asMaker(trackItem(track))));
};
