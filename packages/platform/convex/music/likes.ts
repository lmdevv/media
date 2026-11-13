import { register } from "../../commands/music/likes";
import { fail } from "../core/lib/errors";
import { paginateAtMost } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import { libraryGates } from "./access";
import { trackFacts } from "./items";
import { personMeter, playDecider } from "./person";
import { musicPresenter } from "./present";
import { TRACK_ROW_BYTES, pageRowsFor } from "./reads";
import { musicStore } from "./write";

/** What one like of the list reads besides its library's grants: the like, its track and library. */
const LIKE_ROW_READS = 3;

/**
 * The rows of one person's like of one song a write reads: the one there should be, and a second
 * a defect left beside it, which the write deletes, so a song is liked at most once again.
 */
const LIKE_ROWS_READ = 2;

export const { list, set } = register({
  list: async (ctx, { paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const gates = libraryGates(ctx.db, reach, "view");

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "likes",
        index: "by_user_liked",
        range: (q) => q.eq("userId", caller.userId),
        order: "desc",
      },
      paginationOpts,
      pageRowsFor(reach, LIKE_ROW_READS, TRACK_ROW_BYTES),
    );

    const present = musicPresenter();

    const tracks = await Promise.all(
      page.page.map(async (like) => {
        const track = await ctx.db.get(like.trackId);

        return track !== null &&
          !track.missing &&
          (await gates(track.libraryId))?.admits(trackFacts(track)) === true
          ? [await present.track(track, true)]
          : [];
      }),
    );

    return { ...page, page: tracks.flat() };
  },
  set: async (ctx, { trackId, liked }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const store = musicStore(ctx.db, personMeter(reach));

    if (liked) {
      const track = await store.get("tracks", trackId);

      const allowed =
        track !== null && (await playDecider(ctx.db, reach, store.meter).decide(track));

      if (!allowed) return fail("not_found", "No such track");
    }

    const rows = await store.take(
      "likes",
      (q) =>
        q.withIndex("by_user_track", (index) =>
          index.eq("userId", caller.userId).eq("trackId", trackId),
        ),
      LIKE_ROWS_READ,
    );

    const [kept, ...extra] = rows;
    const leaving = liked ? extra : rows;

    await Promise.all(leaving.map(async (row) => store.deleteLike(row._id)));

    if (liked && kept === undefined) {
      await store.insertLike({ userId: caller.userId, trackId, likedAt: Date.now() });
    }

    return null;
  },
});
