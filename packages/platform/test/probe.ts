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

// SAFETY: as `isLibraryId`, for the `probeItems` ids the seam answers.
const isItemId = (value: unknown): value is Id<"probeItems"> => Schema.is(Schema.String)(value);

const LibraryId = Schema.declare(isLibraryId);

const ItemId = Schema.declare(isItemId);

const Seeded = Schema.Array(Schema.Struct({ libraryId: LibraryId, itemIds: Schema.Array(ItemId) }));

const Opened = Schema.Struct({
  itemId: ItemId,
  path: Schema.String,
  level: Schema.Literals(["view", "edit", "manage"]),
});

const Page = Schema.Struct({
  page: Schema.Array(Opened),
  isDone: Schema.Boolean,
  continueCursor: Schema.String,
});

/** A signed-in client with the ids the probe seam takes. */
export interface Session {
  readonly signedIn: SignedIn;
  readonly userId: Id<"users">;
  readonly username: string;
  readonly sessionId: Id<"authSessions">;
}

type Library = FunctionArgs<typeof internal.core.libraryProbe.seed>["libraries"][number];

/** An item to seed: a movie with a minimum viewer age or none, or a song, explicit or not. */
export type Item = Library["items"][number];

/** A movie; `age` null is unrated. */
export const movie = (name: string, age: number | null): Item => ({ name, age, explicit: false });

export const song = (name: string, explicit: boolean): Item => ({ name, age: null, explicit });

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

const SEED_BATCH = 200;

/**
 * Seeds libraries that `manager` manages, in order, with no scan queued, 200 a call: each library
 * costs its seed a few index ranges, and Convex caps the ranges one transaction reads.
 */
export const seedLibraries = async (
  stack: CoreStack,
  manager: Session,
  libraries: ReadonlyArray<Library>,
): Promise<typeof Seeded.Type> => {
  const batches = Array.from({ length: Math.ceil(libraries.length / SEED_BATCH) }, (_, n) =>
    libraries.slice(n * SEED_BATCH, (n + 1) * SEED_BATCH),
  );

  const seeded = await inOrder(batches, async (batch) =>
    runFunction(
      stack,
      internal.core.libraryProbe.seed,
      { managerId: manager.userId, libraries: [...batch] },
      Seeded,
    ),
  );

  return seeded.flat();
};

/** Seeds one library that `manager` manages. */
export const seedLibrary = async (
  stack: CoreStack,
  manager: Session,
  library: Library,
): Promise<(typeof Seeded.Type)[number]> => {
  const [seeded] = await seedLibraries(stack, manager, [library]);

  if (seeded === undefined) throw new Error("seed made no library");

  return seeded;
};

/** Opens an item as `session` would through a command that declares `scope`. */
export const openItem = (
  stack: CoreStack,
  session: Session,
  itemId: Id<"probeItems">,
  action: FunctionArgs<typeof internal.core.libraryProbe.open>["action"] = "view",
  scope: CallerScope = "signed-in",
): Promise<typeof Opened.Type> =>
  runFunction(
    stack,
    internal.core.libraryProbe.open,
    { sessionId: session.sessionId, scope, action, itemId },
    Opened,
  );

/** Every item of a library `session` sees, page by page. */
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
    Page,
  );

  const next = [...seen, ...page.page.map((item) => item.itemId)];

  return page.isDone ? next : visibleItems(stack, session, libraryId, page.continueCursor, next);
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

/** Libraries shared at once; each library's grants go in one after another. */
const SHARING = 24;

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

  const batches = Array.from({ length: Math.ceil(libraryIds.length / SHARING) }, (_, n) =>
    libraryIds.slice(n * SHARING, (n + 1) * SHARING),
  );

  await inOrder(batches, async (batch) =>
    Promise.all(
      batch.map(async (libraryId) =>
        inOrder(grantees, async (grantee) => share(manager, libraryId, grantee, "view")),
      ),
    ),
  );
};
