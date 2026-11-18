import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { asEpisodeId, asTitleId } from "./catalog";
import type { Episode, HistoryEntry } from "./catalog";
import { historyDetail, historyKey, historyName, historySection, historySections } from "./history";

const asSeasonId = Brand.nominal<Episode["seasonId"]>();

const at = (month: number, day: number): number => new Date(2026, month - 1, day, 20).getTime();

const now = at(10, 17);

const entry = (
  name: string,
  lastPlayedAt: number,
  progress: { readonly positionMs: number; readonly watched: boolean },
  episode: {
    readonly id: string;
    readonly name: string;
    readonly season: number;
    readonly number: number;
  } | null = null,
): HistoryEntry => ({
  title: {
    id: asTitleId(name),
    kind: episode === null ? "movie" : "show",
    name,
    year: 2024,
    certification: null,
    ageRating: null,
    runtimeMs: null,
    genres: [],
    artwork: { poster: null, backdrop: null, logo: null },
    available: true,
    addedAt: 0,
  },
  episode:
    episode === null
      ? null
      : {
          id: asEpisodeId(episode.id),
          titleId: asTitleId(name),
          seasonId: asSeasonId(`${name}-s${episode.season}`),
          seasonNumber: episode.season,
          episodeNumber: episode.number,
          name: episode.name,
          overview: null,
          airDate: null,
          runtimeMs: null,
          still: null,
          rating: null,
          externalIds: { tmdb: null, imdb: null, tvdb: null },
          available: true,
          progress: null,
        },
  progress: {
    positionMs: progress.positionMs,
    durationMs: 120 * 60_000,
    watched: progress.watched,
    updatedAt: lastPlayedAt,
  },
  lastPlayedAt,
});

describe("watch history", () => {
  it("puts entries under day headings", () => {
    expect(historySection(at(10, 17), now)).toBe("Today");
    expect(historySection(at(10, 16), now)).toBe("Yesterday");
    expect(historySection(at(10, 11), now)).toBe("Last Week");
    expect(historySection(at(10, 1), now)).toBe("Last Month");
    expect(historySection(at(8, 1), now)).toBe("Earlier");
  });

  it("groups consecutive entries and drops empty headings", () => {
    const dune = entry("Dune", at(10, 17), { positionMs: 48 * 60_000, watched: false });

    const severance = entry(
      "Severance",
      at(10, 17),
      { positionMs: 0, watched: false },
      {
        id: "e3",
        name: "Who Is Alive?",
        season: 2,
        number: 3,
      },
    );

    const arrival = entry("Arrival", at(10, 12), { positionMs: 120 * 60_000, watched: true });

    expect(
      historySections([dune, severance, arrival], now).map((section) => [
        section.title,
        section.entries.map(historyName),
      ]),
    ).toEqual([
      ["Today", ["Dune", "3. Who Is Alive?"]],
      ["Last Week", ["Arrival"]],
    ]);
    expect(historyDetail(dune)).toBe("1h 12m left");
    expect(historyDetail(severance)).toBe("Severance · S2, E3");
    expect(historyDetail(arrival)).toBe("Watched");
    expect(historyKey(severance)).toBe("Severance:e3");
    expect(historyKey(dune)).toBe("Dune");
  });
});
