import type { FunctionArgs } from "convex/server";
import { Schema } from "effect";

import type { GrantPrincipal, Level } from "../commands/access";
import type { CallerScope } from "../commands/scopes";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { inOrder } from "../convex/core/lib/inOrder";
import { GROUPS_PER_USER_MAX } from "../convex/core/permissions/grants";
import { runFunction } from "./admin";
import { unique } from "./sign-in";
import type { SignedIn } from "./sign-in";
import type { CoreStack } from "./stack-env";

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack answered these through a validator of the id's table; the backend's `v.id(...)`
// validators check each again whenever a test sends it back.
const isLibraryId = (value: unknown): value is Id<"libraries"> => Schema.is(Schema.String)(value);

// SAFETY: as `isLibraryId`, for the `probeItems` ids the music seam answers.
const isItemId = (value: unknown): value is Id<"probeItems"> => Schema.is(Schema.String)(value);

// SAFETY: as `isLibraryId`, for the `titles` ids the movies seam answers.
const isTitleId = (value: unknown): value is Id<"titles"> => Schema.is(Schema.String)(value);

// SAFETY: as `isLibraryId`, for the `mediaFiles` ids the movies seam answers.
const isFileId = (value: unknown): value is Id<"mediaFiles"> => Schema.is(Schema.String)(value);

// SAFETY: as `isLibraryId`, for the `episodes` ids the movies seam answers.
const isEpisodeId = (value: unknown): value is Id<"episodes"> => Schema.is(Schema.String)(value);

const LibraryId = Schema.declare(isLibraryId);

const ItemId = Schema.declare(isItemId);

const TitleId = Schema.declare(isTitleId);

const FileId = Schema.declare(isFileId);

const EpisodeId = Schema.declare(isEpisodeId);

const SeededMusic = Schema.Array(
  Schema.Struct({ libraryId: LibraryId, itemIds: Schema.Array(ItemId) }),
);

const SeededMovies = Schema.Array(
  Schema.Struct({
    libraryId: LibraryId,
    titles: Schema.Array(
      Schema.Struct({
        titleId: TitleId,
        fileIds: Schema.Array(FileId),
        episodeIds: Schema.Array(EpisodeId),
      }),
    ),
  }),
);

const Level = Schema.Literals(["view", "edit", "manage"]);

const Opened = Schema.Struct({ itemId: ItemId, path: Schema.String, level: Level });

const OpenedTitle = Schema.Struct({ titleId: TitleId, name: Schema.String, level: Level });

const pageOf = <Row extends Schema.Top>(row: Row) =>
  Schema.Struct({ page: Schema.Array(row), isDone: Schema.Boolean, continueCursor: Schema.String });

/** A signed-in client with the ids the probe seam takes. */
export interface Session {
  readonly signedIn: SignedIn;
  readonly userId: Id<"users">;
  readonly username: string;
  readonly sessionId: Id<"authSessions">;
}

type MoviesSeed = FunctionArgs<typeof internal.movies.probe.seed>["libraries"][number];

type MusicSeed = FunctionArgs<typeof internal.core.libraryProbe.seed>["libraries"][number];

/** A movie or show to seed, with a minimum viewer age or none for unrated. */
export type Title = MoviesSeed["titles"][number];

/** A song to seed, explicit or not, as the music probe's stand-in for a track. */
export type Song = MusicSeed["items"][number];

/** A movies library to seed. */
export interface MoviesLibrary {
  readonly name: string;
  readonly kind: "movies";
  readonly items: ReadonlyArray<Title>;
}

/** A music library to seed. */
export interface MusicLibrary {
  readonly name: string;
  readonly kind: "music";
  readonly items: ReadonlyArray<Song>;
}

/** A movies library the seam made: its titles, and the first file of each. */
export interface SeededMoviesLibrary {
  readonly libraryId: Id<"libraries">;
  readonly itemIds: ReadonlyArray<Id<"titles">>;
  readonly fileIds: ReadonlyArray<Id<"mediaFiles">>;
  readonly episodeIds: ReadonlyArray<ReadonlyArray<Id<"episodes">>>;
}

/** A music library the probe made, with its tracks. */
export interface SeededMusicLibrary {
  readonly libraryId: Id<"libraries">;
  readonly itemIds: ReadonlyArray<Id<"probeItems">>;
}

/** A movie; `age` null is unrated. */
export const movie = (name: string, age: number | null): Title => ({ name, age, episodes: 0 });

/** A show of one season with `episodes` episodes, each with a file. */
export const show = (name: string, age: number | null, episodes: number): Title => ({
  name,
  age,
  episodes,
});

export const song = (name: string, explicit: boolean): Song => ({ name, explicit });

/** The session behind a signed-in client, read through `core.auth.sessions.current`. */
export const sessionOf = async (signedIn: SignedIn): Promise<Session> => {
  const current = await signedIn.client.query(api.core.auth.sessions.current, {});

  return {
    signedIn,
    userId: current.userId,
    username: current.username,
    sessionId: current.sessionId,
  };
};

/** Libraries one seed call makes, few enough to finish inside a mutation's time on a busy host. */
const SEED_BATCH = 50;

const batchesOf = <Item>(items: ReadonlyArray<Item>): ReadonlyArray<ReadonlyArray<Item>> =>
  Array.from({ length: Math.ceil(items.length / SEED_BATCH) }, (_, n) =>
    items.slice(n * SEED_BATCH, (n + 1) * SEED_BATCH),
  );

const seedMovies = async (
  stack: CoreStack,
  manager: Session,
  libraries: ReadonlyArray<MoviesLibrary>,
): Promise<ReadonlyArray<SeededMoviesLibrary>> => {
  const seeded = await inOrder(batchesOf(libraries), async (batch) =>
    runFunction(
      stack,
      internal.movies.probe.seed,
      {
        managerId: manager.userId,
        libraries: batch.map((library) => ({ name: library.name, titles: [...library.items] })),
      },
      SeededMovies,
    ),
  );

  return seeded.flat().map(({ libraryId, titles }) => ({
    libraryId,
    itemIds: titles.map((title) => title.titleId),
    fileIds: titles.flatMap((title) => title.fileIds.slice(0, 1)),
    episodeIds: titles.map((title) => title.episodeIds),
  }));
};

const seedMusic = async (
  stack: CoreStack,
  manager: Session,
  libraries: ReadonlyArray<MusicLibrary>,
): Promise<ReadonlyArray<SeededMusicLibrary>> => {
  const seeded = await inOrder(batchesOf(libraries), async (batch) =>
    runFunction(
      stack,
      internal.core.libraryProbe.seed,
      {
        managerId: manager.userId,
        libraries: batch.map((library) => ({ name: library.name, items: [...library.items] })),
      },
      SeededMusic,
    ),
  );

  return seeded.flat();
};

/**
 * Seeds libraries that `manager` manages, in order, with no scan queued, 200 a call: each library
 * costs its seed a few index ranges, and Convex caps the ranges one transaction reads. Movies
 * libraries hold movies rows; music libraries hold the probe's stand-ins for tracks.
 */
export function seedLibraries(
  stack: CoreStack,
  manager: Session,
  libraries: ReadonlyArray<MoviesLibrary>,
): Promise<ReadonlyArray<SeededMoviesLibrary>>;
export function seedLibraries(
  stack: CoreStack,
  manager: Session,
  libraries: ReadonlyArray<MusicLibrary>,
): Promise<ReadonlyArray<SeededMusicLibrary>>;
export async function seedLibraries(
  stack: CoreStack,
  manager: Session,
  libraries: ReadonlyArray<MoviesLibrary> | ReadonlyArray<MusicLibrary>,
): Promise<ReadonlyArray<SeededMoviesLibrary> | ReadonlyArray<SeededMusicLibrary>> {
  const movies = libraries.flatMap((library) => (library.kind === "movies" ? [library] : []));
  const music = libraries.flatMap((library) => (library.kind === "music" ? [library] : []));

  return movies.length > 0 ? seedMovies(stack, manager, movies) : seedMusic(stack, manager, music);
}

const only = <Seeded>(seeded: ReadonlyArray<Seeded>): Seeded => {
  const [first] = seeded;

  if (first === undefined) throw new Error("seed made no library");

  return first;
};

/** Seeds one library that `manager` manages. */
export function seedLibrary(
  stack: CoreStack,
  manager: Session,
  library: MoviesLibrary,
): Promise<SeededMoviesLibrary>;
export function seedLibrary(
  stack: CoreStack,
  manager: Session,
  library: MusicLibrary,
): Promise<SeededMusicLibrary>;
export async function seedLibrary(
  stack: CoreStack,
  manager: Session,
  library: MoviesLibrary | MusicLibrary,
): Promise<SeededMoviesLibrary | SeededMusicLibrary> {
  return library.kind === "movies"
    ? only(await seedMovies(stack, manager, [library]))
    : only(await seedMusic(stack, manager, [library]));
}

type Action = FunctionArgs<typeof internal.movies.probe.open>["action"];

/** Opens a track as `session` would through a command that declares `scope`. */
export const openItem = (
  stack: CoreStack,
  session: Session,
  itemId: Id<"probeItems">,
  action: Action = "view",
  scope: CallerScope = "signed-in",
): Promise<typeof Opened.Type> =>
  runFunction(
    stack,
    internal.core.libraryProbe.open,
    { sessionId: session.sessionId, scope, action, itemId },
    Opened,
  );

/** Opens a title as `session` would through a command that declares `scope`. */
export const openTitle = (
  stack: CoreStack,
  session: Session,
  titleId: Id<"titles">,
  action: Action = "view",
  scope: CallerScope = "signed-in",
): Promise<typeof OpenedTitle.Type> =>
  runFunction(
    stack,
    internal.movies.probe.open,
    { sessionId: session.sessionId, scope, action, titleId },
    OpenedTitle,
  );

/** Every track of a music library `session` sees, page by page. */
export const visibleItems = async (
  stack: CoreStack,
  session: Session,
  libraryId: Id<"libraries">,
  cursor: string | null = null,
  seen: ReadonlyArray<Id<"probeItems">> = [],
): Promise<ReadonlyArray<Id<"probeItems">>> => {
  const page = await runFunction(
    stack,
    internal.core.libraryProbe.page,
    {
      sessionId: session.sessionId,
      scope: "signed-in",
      libraryId,
      paginationOpts: { numItems: 100, cursor },
    },
    pageOf(Opened),
  );

  const next = [...seen, ...page.page.map((item) => item.itemId)];

  return page.isDone ? next : visibleItems(stack, session, libraryId, page.continueCursor, next);
};

/** Every title of a movies library `session` sees, page by page. */
export const visibleTitles = async (
  stack: CoreStack,
  session: Session,
  libraryId: Id<"libraries">,
  cursor: string | null = null,
  seen: ReadonlyArray<Id<"titles">> = [],
): Promise<ReadonlyArray<Id<"titles">>> => {
  const page = await runFunction(
    stack,
    internal.movies.probe.page,
    {
      sessionId: session.sessionId,
      scope: "signed-in",
      libraryId,
      paginationOpts: { numItems: 100, cursor },
    },
    pageOf(OpenedTitle),
  );

  const next = [...seen, ...page.page.map((title) => title.titleId)];

  return page.isDone ? next : visibleTitles(stack, session, libraryId, page.continueCursor, next);
};

/** Every library `session` sees through `core.libraries.list`, in pages of `numItems`. */
export const visibleLibraries = async (
  session: Session,
  numItems = 100,
  cursor: string | null = null,
  seen: ReadonlyArray<Id<"libraries">> = [],
): Promise<ReadonlyArray<Id<"libraries">>> => {
  const page = await session.signedIn.client.query(api.core.libraries.list, {
    paginationOpts: { numItems, cursor },
  });

  const next = [...seen, ...page.page.map((library) => library.libraryId)];

  return page.isDone ? next : visibleLibraries(session, numItems, page.continueCursor, next);
};

/** Gives `principal` exactly `level` on a library, as `session`, through `core.permissions.grants.set`. */
export const share = (
  session: Session,
  libraryId: Id<"libraries">,
  principal: GrantPrincipal,
  level: Level,
): Promise<null> =>
  session.signedIn.client.mutation(api.core.permissions.grants.set, {
    resource: { type: "library", id: libraryId },
    principal,
    level,
  });

/** Takes `principal`'s grant on a library away, as `session`, through `core.permissions.grants.remove`. */
export const unshare = (
  session: Session,
  libraryId: Id<"libraries">,
  principal: GrantPrincipal,
): Promise<null> =>
  session.signedIn.client.mutation(api.core.permissions.grants.remove, {
    resource: { type: "library", id: libraryId },
    principal,
  });

const LIBRARIES_SHARED_AT_ONCE = 24;

/**
 * Puts `viewer` in as many groups as a person may be in, then gives them `view` on each library,
 * as `manager`, both directly and through every group: the most grants one check of theirs reads.
 */
export const shareThroughEveryGroup = async (
  admin: Session,
  manager: Session,
  viewer: Session,
  libraryIds: ReadonlyArray<Id<"libraries">>,
): Promise<void> => {
  const groups = await inOrder(
    Array.from({ length: GROUPS_PER_USER_MAX }, (_, n) => n),
    async (n) => {
      const { groupId } = await admin.signedIn.client.mutation(api.core.permissions.groups.create, {
        name: `every-${unique()}-${n}`,
      });

      await admin.signedIn.client.mutation(api.core.permissions.groups.addMember, {
        groupId,
        userId: viewer.userId,
      });

      return groupId;
    },
  );

  const grantees: ReadonlyArray<GrantPrincipal> = [
    { kind: "user", userId: viewer.userId },
    ...groups.map((groupId): GrantPrincipal => ({ kind: "group", groupId })),
  ];

  const batches = Array.from(
    { length: Math.ceil(libraryIds.length / LIBRARIES_SHARED_AT_ONCE) },
    (_, n) => libraryIds.slice(n * LIBRARIES_SHARED_AT_ONCE, (n + 1) * LIBRARIES_SHARED_AT_ONCE),
  );

  await inOrder(batches, async (batch) =>
    Promise.all(
      batch.map(async (libraryId) =>
        inOrder(grantees, async (grantee) => share(manager, libraryId, grantee, "view")),
      ),
    ),
  );
};
