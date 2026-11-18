import { describe, expect, it } from "vitest";

import { allOfSeason, openingPageArgs, openingSeason, seasonPageArgs } from "./opening-season";

describe("openingSeason", () => {
  it("opens on the next episode's season, Specials included", () => {
    expect(openingSeason({ nextSeason: 2, seasons: [0, 1, 2] })).toBe(2);
    expect(openingSeason({ nextSeason: 0, seasons: [0, 1] })).toBe(0);
  });

  it("opens a finished show on its first regular season, not its Specials", () => {
    expect(openingSeason({ nextSeason: null, seasons: [0, 1, 2] })).toBe(1);
    expect(openingSeason({ nextSeason: null, seasons: [0, 3] })).toBe(3);
  });

  it("opens a show of Specials alone on them, and a show with no seasons on none", () => {
    expect(openingSeason({ nextSeason: null, seasons: [0] })).toBe(0);
    expect(openingSeason({ nextSeason: null, seasons: [] })).toBeNull();
  });
});

describe("allOfSeason", () => {
  it("holds for a season's own rows and for none, and not once another season's row is among them", () => {
    expect(allOfSeason([{ seasonNumber: 1 }, { seasonNumber: 1 }], 1)).toBe(true);
    expect(allOfSeason([], 1)).toBe(true);
    expect(allOfSeason([{ seasonNumber: 1 }, { seasonNumber: 2 }], 1)).toBe(false);
  });
});

describe("seasonPageArgs", () => {
  const first = { numItems: 25, cursor: null };

  it("leaves the season out of the open-ended first page of the opening season alone", () => {
    expect(seasonPageArgs("show", 2, true, first)).toEqual(openingPageArgs("show", first));
    expect(seasonPageArgs("show", 2, false, first)).toEqual({
      titleId: "show",
      seasonNumber: 2,
      paginationOpts: first,
    });
  });

  it("names the season on a later page and on a first page pinned to an end", () => {
    const later = { numItems: 25, cursor: "after" };
    const pinned = { numItems: 25, cursor: null, endCursor: "end" };

    expect(seasonPageArgs("show", 2, true, later)).toEqual({
      titleId: "show",
      seasonNumber: 2,
      paginationOpts: later,
    });
    expect(seasonPageArgs("show", 2, true, pinned)).toEqual({
      titleId: "show",
      seasonNumber: 2,
      paginationOpts: pinned,
    });
  });
});
