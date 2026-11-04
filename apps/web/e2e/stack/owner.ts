import type { CreatedInvite } from "@media/contracts/models/account";
import { createMovies } from "@media/sdk/promise";

import type { StackEnv } from "./stack-env";

/**
 * The owner every stack suite signs in as. The suites run on a fresh stack, so the owner can have
 * fixed credentials: the core flows create it, and the admin suites sign in with it after.
 */
export const OWNER = { name: "Alex", email: "owner@movies.test", password: "correct-horse-1" };

/** A member invite and the id of the owner who made it. */
export interface OwnerInvite {
  readonly invite: CreatedInvite;
  readonly ownerId: string;
}

/** Signs in as the owner and creates a member invite. */
export const createInvite = async (
  stack: StackEnv,
  owner: { readonly email: string; readonly password: string },
): Promise<OwnerInvite> => {
  const movies = createMovies({ convexUrl: stack.convexUrl, connection: "http" });

  try {
    await movies.auth.signInWithPassword({
      flow: "signIn",
      email: owner.email,
      password: owner.password,
    });

    const viewer = await movies.query("account.viewer", {});
    const invite = await movies.action("invites.create", { role: "member" });

    return { invite, ownerId: viewer.user.id };
  } finally {
    await movies.dispose();
  }
};
