import type { Episode, EpisodeId, Progress, TitleId } from "@/lib/catalog";
import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { continueMenu, episodeMenu, titleMenu } from "./menu-items";
import type { MenuItem } from "./menu-items";

const brand = <B extends Brand.Brand<string>>() => Brand.nominal<B>();

const progress = (watched: boolean): Progress => ({
  positionMs: watched ? 60_000 : 20_000,
  durationMs: 60_000,
  watched,
  updatedAt: 0,
});

const episode = (
  seasonNumber: number,
  episodeNumber: number,
  progressOf: Progress | null = null,
): Episode => ({
  id: brand<EpisodeId>()(`e${seasonNumber}-${episodeNumber}`),
  titleId: brand<TitleId>()("show"),
  seasonId: brand<Episode["seasonId"]>()(`s${seasonNumber}`),
  seasonNumber,
  episodeNumber,
  name: "Episode",
  overview: null,
  airDate: null,
  runtimeMs: null,
  still: null,
  rating: null,
  externalIds: { tmdb: null, imdb: null, tvdb: null },
  available: true,
  progress: progressOf,
});

/** The menu as the person reads it, one label per row. */
const labels = (items: ReadonlyArray<MenuItem>): ReadonlyArray<string> =>
  items.map((item) => {
    if (item.kind === "play") return item.label;

    if (item.kind === "myList") return item.inList ? "Remove from My List" : "Add to My List";

    if (item.kind === "mark") {
      const aim = item.episodeId === undefined ? "" : ` (${item.episodeId})`;

      return `Mark as ${item.watched ? "watched" : "unwatched"}${aim}`;
    }

    return "Go to title";
  });

const showMenu = (next: Episode | null): ReadonlyArray<string> =>
  labels(titleMenu(true, { kind: "show", progress: null, nextEpisode: next, inMyList: false }));

describe("titleMenu", () => {
  it("holds only Go to title until the title's page answers", () => {
    expect(labels(titleMenu(true, undefined))).toEqual(["Go to title"]);
  });

  it("offers an untouched movie Play, Add to My List, and Mark as watched", () => {
    const movie = { kind: "movie", progress: null, nextEpisode: null, inMyList: false } as const;

    expect(labels(titleMenu(true, movie))).toEqual([
      "Play",
      "Add to My List",
      "Mark as watched",
      "Go to title",
    ]);
  });

  it("resumes a started movie and offers both marks", () => {
    const movie = {
      kind: "movie",
      progress: progress(false),
      nextEpisode: null,
      inMyList: true,
    } as const;

    expect(labels(titleMenu(true, movie))).toEqual([
      "Resume",
      "Remove from My List",
      "Mark as watched",
      "Mark as unwatched",
      "Go to title",
    ]);
  });

  it("offers a watched movie only Mark as unwatched, and no Play when its file is missing", () => {
    const movie = {
      kind: "movie",
      progress: progress(true),
      nextEpisode: null,
      inMyList: false,
    } as const;

    expect(labels(titleMenu(false, movie))).toEqual([
      "Add to My List",
      "Mark as unwatched",
      "Go to title",
    ]);
  });

  it("offers a show both marks, since its page doesn't say what was watched", () => {
    expect(showMenu(episode(1, 1))).toEqual([
      "Play S1:E1",
      "Add to My List",
      "Mark as watched",
      "Mark as unwatched",
      "Go to title",
    ]);
    expect(showMenu(episode(1, 3, progress(false)))).toEqual([
      "Resume S1:E3",
      "Add to My List",
      "Mark as watched",
      "Mark as unwatched",
      "Go to title",
    ]);
  });
});

describe("continueMenu", () => {
  const title = { available: true };

  it("aims a resumed episode's marks at that episode", () => {
    const item = { title, episode: episode(1, 3, progress(false)), progress: progress(false) };

    expect(labels(continueMenu(item, false))).toEqual([
      "Resume S1:E3",
      "Add to My List",
      "Mark as watched (e1-3)",
      "Mark as unwatched (e1-3)",
      "Go to title",
    ]);
  });

  it("plays the next episode and leaves My List out until the title answers", () => {
    const item = { title, episode: episode(1, 4), progress: null };

    expect(labels(continueMenu(item, undefined))).toEqual([
      "Play S1:E4",
      "Mark as watched (e1-4)",
      "Go to title",
    ]);
  });

  it("resumes a movie and marks the whole movie", () => {
    expect(labels(continueMenu({ title, episode: null, progress: progress(false) }, true))).toEqual(
      ["Resume", "Remove from My List", "Mark as watched", "Mark as unwatched", "Go to title"],
    );
  });
});

describe("episodeMenu", () => {
  it("offers play and the marks that change the episode", () => {
    expect(labels(episodeMenu(episode(2, 1)))).toEqual(["Play", "Mark as watched (e2-1)"]);
    expect(labels(episodeMenu(episode(2, 1, progress(false))))).toEqual([
      "Resume",
      "Mark as watched (e2-1)",
      "Mark as unwatched (e2-1)",
    ]);
    expect(labels(episodeMenu({ ...episode(2, 1, progress(true)), available: false }))).toEqual([
      "Mark as unwatched (e2-1)",
    ]);
  });
});
