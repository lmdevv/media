import { v } from "convex/values";

import { internalQuery } from "../_generated/server";

/**
 * The stack suite's view of the pages `movies.history.markWatched` and `markUnwatched` scheduled
 * for a show, so a test can wait for them and send a superseded one again. The server never calls
 * it. Each page's arguments come back as the JSON Convex stored them.
 */
export const scheduledMarks = internalQuery({
  args: {},
  returns: v.array(v.object({ state: v.string(), args: v.string() })),
  handler: async (ctx) => {
    const scheduled = await ctx.db.system.query("_scheduled_functions").order("desc").take(200);

    return scheduled
      .filter((row) => row.name.includes("history") && row.name.endsWith("markRest"))
      .map((row) => ({ state: row.state.kind, args: JSON.stringify(row.args) }));
  },
});
