import { register } from "../../commands/music/playback";
import type { Doc } from "../_generated/dataModel";
import { fail } from "../core/lib/errors";
import { paginateAtMost } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import { playableBy } from "../core/permissions/items";
import { trackPlayer } from "./access";
import { musicPresenter } from "./present";

const PAGE_MAX = 50;

const trackDescription = async (
  track: Doc<"tracks">,
  art: ReturnType<typeof musicPresenter>["art"],
) => ({
  kind: "track" as const,
  id: track._id,
  title: track.title,
  artist: track.artistName,
  album: track.albumTitle,
  trackNumber: track.trackNumber,
  discNumber: track.discNumber,
  durationMs: track.durationMs,
  artUrl: await art(track.artHash),
});

export const { get, tracks } = register({
  get: async (ctx, { item }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const present = musicPresenter();

    if (item.type === "track") {
      const track = await ctx.db.get(item.id);

      if (track === null || track.missing || !(await trackPlayer(ctx.db, reach)(track))) {
        return fail("not_found", "No such track");
      }

      return trackDescription(track, present.art);
    }

    if (!(await playableBy(ctx.db, reach)({ domain: "music", ref: item }))) {
      return fail("not_found", "No such album");
    }

    const album = (await ctx.db.get(item.id)) ?? fail("not_found", "No such album");

    return {
      kind: "album" as const,
      id: album._id,
      title: album.title,
      artist: album.artistName,
      year: album.year,
      genre: album.genre,
      format: album.format,
      artUrl: await present.art(album.artHash),
    };
  },
  tracks: async (ctx, { albumId, paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);

    if (
      !(await playableBy(ctx.db, reach)({ domain: "music", ref: { type: "album", id: albumId } }))
    ) {
      return fail("not_found", "No such album");
    }

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "tracks",
        index: "by_album",
        range: (q) => q.eq("albumId", albumId),
      },
      paginationOpts,
      PAGE_MAX,
    );

    const decide = trackPlayer(ctx.db, reach);
    const present = musicPresenter();

    const permitted = await Promise.all(
      page.page.map(async (track) =>
        !track.missing && (await decide(track)) ? [await trackDescription(track, present.art)] : [],
      ),
    );

    return { ...page, page: permitted.flat() };
  },
});
