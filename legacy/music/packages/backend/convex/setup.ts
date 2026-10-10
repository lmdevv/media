import { query } from "./_generated/server";

/** First-run state for the welcome screen. Public: it reveals only whether setup is done. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db.query("users").first();
    const library = await ctx.db.query("libraries").first();

    return { hasUsers: user !== null, hasLibraries: library !== null };
  },
});
