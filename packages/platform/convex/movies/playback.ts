import { register } from "../../commands/movies/playback";
import type { Handlers } from "../../commands/movies/playback";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { paginateAtMost } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import { playableBy } from "../core/permissions/items";
import { registerWithArtworkTickets } from "./artwork";
import { mayPlayFile } from "./playable";
import { filesOnDisk, presentVersion } from "./present";
import { findProgress } from "./viewing";

const PAGE_MAX = 50;

type Item = Parameters<Handlers["get"]>[1]["item"];

const episodeDescription = (episode: Doc<"episodes">) => ({
  id: episode._id,
  seasonNumber: episode.seasonNumber,
  episodeNumber: episode.episodeNumber,
  name: episode.name,
  overview: episode.overview,
  runtimeMs: episode.runtimeMs,
  still: episode.still,
});

const titleOf = async (db: DatabaseReader, titleId: Id<"titles">) => {
  const title = await db.get(titleId);

  return title === null || title.purging === true ? fail("not_found", "No such item") : title;
};

const loadItem = async (db: DatabaseReader, item: Item) => {
  switch (item.type) {
    case "title":
      return { title: await titleOf(db, item.id), episode: null, file: null };
    case "episode": {
      const episode = (await db.get(item.id)) ?? fail("not_found", "No such item");

      return { title: await titleOf(db, episode.titleId), episode, file: null };
    }

    case "file": {
      const file = await db.get(item.id);

      if (file === null || file.missing) return fail("not_found", "No such item");

      const title = await titleOf(db, file.titleId);
      const episode = file.episodeId === null ? null : await db.get(file.episodeId);

      if (file.episodeId !== null && (episode === null || episode.titleId !== title._id)) {
        return fail("not_found", "No such item");
      }

      return { title, episode, file };
    }

    default: {
      const exhaustive: never = item;

      return exhaustive;
    }
  }
};

const requireShow = async (
  db: DatabaseReader,
  titleId: Id<"titles">,
  decide: ReturnType<typeof playableBy>,
) => {
  const title = await titleOf(db, titleId);

  if (
    title.kind !== "show" ||
    !(await decide({ domain: "movies", ref: { type: "title", id: titleId } }))
  ) {
    fail("not_found", "No such item");
  }
};

export const { get, seasons, episodes } = registerWithArtworkTickets(register, {
  get: async (ctx, { item }, caller) => {
    const { title, episode, file } = await loadItem(ctx.db, item);
    const decide = playableBy(ctx.db, await reachOf(ctx.db, caller));
    const asTitle = { domain: "movies", ref: { type: "title", id: title._id } } as const;

    const allowed =
      file !== null
        ? await mayPlayFile(decide, title, episode, file)
        : (await decide({ domain: "movies", ref: item })) ||
          (episode !== null && (await decide(asTitle)));

    if (!allowed) return fail("not_found", "No such item");

    const files =
      file !== null
        ? [file]
        : title.kind === "show" && episode === null
          ? []
          : await filesOnDisk(ctx.db, title, episode);

    const progress =
      files.length === 0
        ? null
        : await findProgress(ctx.db, caller.userId, title._id, episode?._id ?? null);

    const permitted = await Promise.all(
      files.map(async (version) =>
        (await mayPlayFile(decide, title, episode, version))
          ? [presentVersion(version, progress?.fileId ?? null)]
          : [],
      ),
    );

    return {
      titleId: title._id,
      kind: title.kind,
      name: title.overrides?.name ?? title.name,
      year: title.overrides?.year ?? title.year,
      overview: title.overrides?.overview ?? title.overview,
      runtimeMs: title.runtimeMs,
      certification: title.overrides?.certification ?? title.certification,
      artwork: title.artwork,
      episode: episode === null ? null : episodeDescription(episode),
      versions: permitted.flat(),
    };
  },
  seasons: async (ctx, { titleId, paginationOpts }, caller) => {
    await requireShow(ctx.db, titleId, playableBy(ctx.db, await reachOf(ctx.db, caller)));

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "seasons",
        index: "by_title_number",
        range: (q) => q.eq("titleId", titleId),
      },
      paginationOpts,
      PAGE_MAX,
    );

    return {
      ...page,
      page: page.page.map((season) => ({
        seasonNumber: season.seasonNumber,
        name: season.name,
        poster: season.poster,
      })),
    };
  },
  episodes: async (ctx, { titleId, seasonNumber, paginationOpts }, caller) => {
    await requireShow(ctx.db, titleId, playableBy(ctx.db, await reachOf(ctx.db, caller)));

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "episodes",
        index: "by_title_order",
        range: (q) => q.eq("titleId", titleId).eq("seasonNumber", seasonNumber),
      },
      paginationOpts,
      PAGE_MAX,
    );

    return { ...page, page: page.page.map(episodeDescription) };
  },
});
