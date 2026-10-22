import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import type { Role } from "@music/commands/models";
import { can, canManageLibrary } from "@music/commands/permissions";

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { fail, failEnded } from "./errors";
import { tableId } from "./ids";
import { isStale, keyLapsed } from "./sessions";

export type ReadCtx = Pick<QueryCtx, "db" | "auth">;

/** The signed-in user and the libraries they may read. */
export interface Viewer {
  readonly id: Id<"users">;
  readonly user: Doc<"users">;
  readonly role: Role;
  readonly libraries: ReadonlyArray<Doc<"libraries">>;
  readonly libraryIds: ReadonlySet<Id<"libraries">>;
  /**
   * Whether the viewer reads every library on the server, so a list can page one index over all
   * of them instead of one range per library they read.
   */
  readonly readsEveryLibrary: boolean;
}

/** A stored user's role; accounts from before roles were stored are members. */
export const roleOf = (user: Doc<"users">): Role => user.role ?? "member";

/**
 * Whether someone can listen to a library: its owner always; others by its visibility, where
 * `shared` lets in everyone but guests and the access list (`granted`) adds people to `shared`
 * and `restricted` libraries.
 */
export const canListen = (
  library: Doc<"libraries">,
  userId: Id<"users">,
  role: Role,
  granted: boolean,
): boolean => {
  if (library.ownerId === userId) return true;

  if (library.visibility === "private") return false;

  return granted || (library.visibility === "shared" && role !== "guest");
};

/**
 * Every library on the server, and the ones `user` can listen to. A server has a handful of
 * libraries, and a grant is looked up only for each library whose access list decides (see
 * `listenableIn`), so both reads stay that small.
 */
export const listenable = async (
  ctx: ReadCtx,
  user: Doc<"users">,
): Promise<{
  readonly all: ReadonlyArray<Doc<"libraries">>;
  readonly libraries: ReadonlyArray<Doc<"libraries">>;
}> => {
  const all = await ctx.db.query("libraries").collect();

  return { all, libraries: await listenableIn(ctx, all, user) };
};

/** Whether `user`'s access to `library` turns on its access list rather than its visibility. */
const turnsOnGrant = (library: Doc<"libraries">, user: Doc<"users">): boolean =>
  library.ownerId !== user._id &&
  (library.visibility === "restricted" ||
    (library.visibility === "shared" && roleOf(user) === "guest"));

/**
 * Grants read at once for a person. A person has at most one per library, plus any a removed
 * library left until its purge runs (`maintenance:purgeLibraryAccess`), so this covers every
 * real case in one range read; past it, grants are looked up library by library.
 */
const GRANT_READ = 256;

/** The libraries among `all` whose access list grants `user`, read as `listenableIn` says. */
const grantedIn = async (
  ctx: ReadCtx,
  all: ReadonlyArray<Doc<"libraries">>,
  user: Doc<"users">,
): Promise<ReadonlySet<Id<"libraries">>> => {
  const grants = await ctx.db
    .query("libraryAccess")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .take(GRANT_READ + 1);

  const deciding = all.filter((library) => turnsOnGrant(library, user));

  if (grants.length <= GRANT_READ) {
    // Grants of libraries that are gone match nothing here.
    const held = new Set(grants.map((grant) => grant.libraryId));

    return new Set(deciding.flatMap((library) => (held.has(library._id) ? [library._id] : [])));
  }

  // More grants than any real person holds: removed libraries left many. Look each one up.
  const found = await Promise.all(
    deciding.map(async (library) =>
      (await ctx.db
        .query("libraryAccess")
        .withIndex("by_user", (q) => q.eq("userId", user._id).eq("libraryId", library._id))
        .first()) === null
        ? []
        : [library._id],
    ),
  );

  return new Set(found.flat());
};

/**
 * The libraries of `all` that `user` can listen to: one bounded read of their grants, which
 * stale grants of removed libraries can't crowd a real one out of (`grantedIn`).
 */
const listenableIn = async (
  ctx: ReadCtx,
  all: ReadonlyArray<Doc<"libraries">>,
  user: Doc<"users">,
): Promise<ReadonlyArray<Doc<"libraries">>> => {
  const role = roleOf(user);
  const granted = await grantedIn(ctx, all, user);

  return all.filter((library) => canListen(library, user._id, role, granted.has(library._id)));
};

/**
 * Whether `target` can listen to a library `actor` cannot. Whoever can take over `target`'s
 * account (with a password reset link) would hear it, so only the owner may then.
 */
export const listensBeyond = async (
  ctx: ReadCtx,
  actor: Doc<"users">,
  target: Doc<"users">,
): Promise<boolean> => {
  const all = await ctx.db.query("libraries").collect();

  const [mine, theirs] = await Promise.all([
    listenableIn(ctx, all, actor),
    listenableIn(ctx, all, target),
  ]);

  const readable = new Set(mine.map((library) => library._id));

  return theirs.some((library) => !readable.has(library._id));
};

/** The suspended-account message sign-in, API keys, and open sessions all show. */
export const SUSPENDED_MESSAGE = "This account is suspended. Ask an admin on this server.";

/** Loads the viewer or fails with `unauthenticated`. */
export const loadViewer = async (ctx: ReadCtx): Promise<Viewer> => {
  const userId = await getAuthUserId(ctx);

  if (userId === null) return fail("unauthenticated", "Sign in first");

  // Removing or suspending someone ends their sessions too, so the person is checked before the
  // session: their token, signed for them, then hears why it stopped working.
  const user = await ctx.db.get(userId);

  if (user === null) return failEnded("removed", "This account no longer exists");

  if (user.suspendedAt !== undefined) return failEnded("suspended", SUSPENDED_MESSAGE);

  // A token outlives sign-out and key revocation by up to its one-hour lifetime unless the
  // session it names is checked here; ending a session must end its tokens at once.
  const sessionId = ctx.db.normalizeId("authSessions", (await getAuthSessionId(ctx)) ?? "");
  const session = sessionId === null ? null : await ctx.db.get(sessionId);

  if (session === null || session.userId !== userId || isStale(session, user)) {
    return fail("unauthenticated", "This session has ended; sign in again");
  }

  // A session an API key opened ends with the key's right to work: at once for a guest, who has
  // no keys, and for keys made before a demotion to guest, which a promotion doesn't revive.
  // Others pay no extra read.
  if (!can(roleOf(user), "keys") || user.keysValidAfter !== undefined) {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .first();

    if (key !== null && (!can(roleOf(user), "keys") || keyLapsed(key, user))) {
      return fail("unauthenticated", "This API key no longer works");
    }
  }

  return viewerOf(ctx, user);
};

/**
 * Someone as a viewer, with the libraries they may read. `loadViewer` builds the signed-in
 * person's; a Jam builds its host's, whose queue its members play.
 */
export const viewerOf = async (ctx: ReadCtx, user: Doc<"users">): Promise<Viewer> => {
  const { all, libraries } = await listenable(ctx, user);

  return {
    id: user._id,
    user,
    role: roleOf(user),
    libraries,
    libraryIds: new Set(libraries.map((library) => library._id)),
    readsEveryLibrary: libraries.length === all.length,
  };
};

/** Checks that the viewer can read a library-owned document. */
export const canRead = (viewer: Viewer, libraryId: Id<"libraries">): boolean =>
  viewer.libraryIds.has(libraryId);

/**
 * Checks that the viewer can rename, rescan, or remove a library (`canManageLibrary`): the server's
 * owner every library, an admin the ones they can listen to. Admins see that the others exist,
 * without their folder paths. Who may listen is the library owner's to change
 * (`libraryAccessControl`).
 */
export const canManage = (viewer: Viewer, library: Doc<"libraries">): boolean =>
  canManageLibrary(viewer.role, canRead(viewer, library._id));

/** A person by wire ID, or a `not_found` failure. */
export const loadPerson = async (ctx: ReadCtx, id: string): Promise<Doc<"users">> =>
  (await ctx.db.get(tableId(ctx, "users", id))) ?? fail("not_found", "Person not found");
