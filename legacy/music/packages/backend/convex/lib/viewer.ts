import { getAuthUserId } from "@convex-dev/auth/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { fail } from "./errors";

export type ReadCtx = Pick<QueryCtx, "db" | "auth">;

/** The signed-in user and the libraries they may read. */
export interface Viewer {
  readonly id: Id<"users">;
  readonly user: Doc<"users">;
  readonly role: "admin" | "member";
  readonly libraries: ReadonlyArray<Doc<"libraries">>;
  readonly libraryIds: ReadonlySet<Id<"libraries">>;
}

/** Loads the viewer or fails with `unauthenticated`. */
export const loadViewer = async (ctx: ReadCtx): Promise<Viewer> => {
  const userId = await getAuthUserId(ctx);

  if (userId === null) return fail("unauthenticated", "Sign in first");
  const user = await ctx.db.get(userId);

  if (user === null) return fail("unauthenticated", "This account no longer exists");
  const all = await ctx.db.query("libraries").collect();

  const libraries = all.filter(
    (library) => library.visibility === "shared" || library.ownerId === userId,
  );

  return {
    id: userId,
    user,
    role: user.role ?? "member",
    libraries,
    libraryIds: new Set(libraries.map((library) => library._id)),
  };
};

/** Checks that the viewer can read a library-owned document. */
export const canRead = (viewer: Viewer, libraryId: Id<"libraries">): boolean =>
  viewer.libraryIds.has(libraryId);
