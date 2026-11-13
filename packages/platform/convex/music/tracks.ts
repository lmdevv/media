import { register } from "../../commands/music/tracks";
import { paginateAtMost } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import { libraryGates } from "./access";
import { trackFacts } from "./items";
import { likedAmong, musicPresenter } from "./present";
import { TRACK_ROW_BYTES, pageRowsFor } from "./reads";

/** What one song of the list reads besides its library's grants: it, its library, and its like. */
const TRACK_ROW_READS = 3;

export const { list } = register({
  list: async (ctx, { paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const gates = libraryGates(ctx.db, reach, "view");

    const page = await paginateAtMost(
      ctx.db,
      { table: "tracks", index: "by_title", range: (q) => q.eq("missing", false) },
      paginationOpts,
      pageRowsFor(reach, TRACK_ROW_READS, TRACK_ROW_BYTES),
    );

    const decided = await Promise.all(
      page.page.map(async (track) =>
        (await gates(track.libraryId))?.admits(trackFacts(track)) === true ? [track] : [],
      ),
    );

    const shown = decided.flat();

    const liked = await likedAmong(
      ctx.db,
      caller.userId,
      shown.map((track) => track._id),
    );

    const present = musicPresenter();

    return {
      ...page,
      page: await Promise.all(
        shown.map(async (track) => present.track(track, liked.has(track._id))),
      ),
    };
  },
});
