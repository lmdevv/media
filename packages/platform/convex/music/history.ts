import { register } from "../../commands/music/history";
import { paginateAtMost } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import { libraryGates } from "./access";
import { DOCUMENT_BYTES } from "./fit";
import { trackFacts } from "./items";
import { likedAmong, musicPresenter } from "./present";
import { TRACK_ROW_BYTES, pageRowsFor } from "./reads";

/**
 * What one play of the list reads besides its library's grants: the play, its track and library,
 * and whether the caller likes the track.
 */
const PLAY_ROW_READS = 4;

export const { list } = register({
  list: async (ctx, { paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const gates = libraryGates(ctx.db, reach, "view");

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "plays",
        index: "by_user_played",
        range: (q) => q.eq("userId", caller.userId),
        order: "desc",
      },
      paginationOpts,
      pageRowsFor(reach, PLAY_ROW_READS, TRACK_ROW_BYTES + DOCUMENT_BYTES.small),
    );

    const seen = await Promise.all(
      page.page.map(async (play) => {
        const track = await ctx.db.get(play.trackId);

        return track !== null && (await gates(track.libraryId))?.admits(trackFacts(track)) === true
          ? [{ playedAt: play.playedAt, track }]
          : [];
      }),
    );

    const entries = seen.flat();

    const liked = await likedAmong(
      ctx.db,
      caller.userId,
      entries.map(({ track }) => track._id),
    );

    const present = musicPresenter();

    return {
      ...page,
      page: await Promise.all(
        entries.map(async ({ playedAt, track }) => ({
          playedAt,
          track: await present.track(track, liked.has(track._id)),
        })),
      ),
    };
  },
});
