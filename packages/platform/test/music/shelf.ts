import type { Restrictions } from "../../commands/access";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { member, sharedAdmin } from "../devices";
import type { Member } from "../devices";
import { seedLibrary, share } from "../probe";
import type { SeededMusicLibrary, Song } from "../probe";
import { unique } from "../sign-in";
import type { CoreStack } from "../stack-env";

/** A kid's restrictions with only the explicit filter on (D17). */
const EXPLICIT_FILTER: Restrictions = {
  maxMovieAge: null,
  hideUnrated: false,
  hideExplicitMusic: true,
  libraries: null,
};

/** A song on `album`, explicit or not. */
export const onAlbum = (album: string, name: string, explicit = false): Song => ({
  name,
  explicit,
  album,
});

/** A music library `manager` seeded with `songs`, shared to view with each of `viewers`. */
export interface Shelf {
  readonly manager: Member;
  readonly library: SeededMusicLibrary;
}

/** Seeds a music library of `songs` managed by a new member, shared with `viewers` to view. */
export const musicShelf = async (
  stack: CoreStack,
  viewers: ReadonlyArray<Member>,
  songs: ReadonlyArray<Song>,
  manager?: Member,
): Promise<Shelf> => {
  const owner = manager ?? (await member(stack, "music-manager"));

  const library = await seedLibrary(stack, owner, {
    name: `shelf-${unique()}`,
    kind: "music",
    items: [...songs],
  });

  await Promise.all(
    viewers.map(async (viewer) =>
      share(owner, library.libraryId, { kind: "user", userId: viewer.userId }, "view"),
    ),
  );

  return { manager: owner, library };
};

/** A member the shared admin made a kid with the explicit filter on. */
export const explicitKid = async (stack: CoreStack, label: string): Promise<Member> => {
  const admin = await sharedAdmin(stack);
  const kid = await member(stack, label);

  await admin.signedIn.client.mutation(api.core.restrictions.set, {
    userId: kid.userId,
    restrictions: EXPLICIT_FILTER,
  });

  return kid;
};

/** One page of a list, as the music commands answer it. */
export interface Page<Row> {
  readonly page: ReadonlyArray<Row>;
  readonly isDone: boolean;
  readonly continueCursor: string;
}

/** Every row of a list, read a page at a time from the start, and the calls it took. */
export const allPages = async <Row>(
  read: (cursor: string | null) => Promise<Page<Row>>,
  cursor: string | null = null,
  rows: ReadonlyArray<Row> = [],
  calls = 0,
): Promise<{ readonly rows: ReadonlyArray<Row>; readonly calls: number }> => {
  const page = await read(cursor);
  const next = [...rows, ...page.page];

  return page.isDone
    ? { rows: next, calls: calls + 1 }
    : allPages(read, page.continueCursor, next, calls + 1);
};

/** The value at `index`, or a test failure. */
export const at = <T>(values: ReadonlyArray<T>, index: number): T => {
  const value = values[index];

  if (value === undefined) throw new Error(`no value at ${index}`);

  return value;
};

/** The ids a list names, of the rows it shares with `ours`, in its order. */
export const ofOurs = (
  rows: ReadonlyArray<{ readonly id: string }>,
  ours: ReadonlySet<string>,
): ReadonlyArray<string> => rows.flatMap((row) => (ours.has(row.id) ? [row.id] : []));

/** A track id of a seeded library, by its position. */
export const trackAt = (shelf: Shelf, index: number): Id<"tracks"> =>
  at(shelf.library.itemIds, index);
