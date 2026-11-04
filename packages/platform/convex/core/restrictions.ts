import type { Restrictions } from "../../commands/access";
import { register } from "../../commands/core/restrictions";
import { fail } from "./lib/errors";
import { requireAccount } from "./permissions/authorize";
import { restrictionsOf } from "./permissions/policy";

/** The highest minimum viewer age a rating carries: NC-17 is 18, and some countries go to 21. */
const MOVIE_AGE_MAX = 21;

const LIBRARIES_MAX = 64;

const parseRestrictions = (typed: Restrictions): Restrictions => {
  const { maxMovieAge } = typed;

  if (
    maxMovieAge !== null &&
    (!Number.isInteger(maxMovieAge) || maxMovieAge < 0 || maxMovieAge > MOVIE_AGE_MAX)
  ) {
    return fail(
      "invalid_args",
      `The highest movie age is a whole number from 0 to ${MOVIE_AGE_MAX}`,
    );
  }

  const libraries = typed.libraries === null ? null : [...new Set(typed.libraries)];

  return libraries !== null && libraries.length > LIBRARIES_MAX
    ? fail("invalid_args", `Allow at most ${LIBRARIES_MAX} libraries`)
    : { ...typed, libraries };
};

export const { get, set } = register({
  get: async (ctx, { userId }, caller) =>
    restrictionsOf(await requireAccount(ctx, caller, "viewRestrictions", userId)),
  set: async (ctx, { userId, restrictions }, caller) => {
    const person = await requireAccount(ctx, caller, "restrict", userId);

    await ctx.db.patch(person._id, {
      restrictions: restrictions === null ? undefined : parseRestrictions(restrictions),
    });

    return null;
  },
});
