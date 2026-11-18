import type { MetadataCandidate } from "@media/contracts/models/catalog";
import { describe, expect, it } from "vitest";

import { editFor, overridesFor, parseYear, planFor } from "./match-plan";

const current = editFor({ name: "Sintel", year: 2010, tmdbId: "45745" });

const candidate: MetadataCandidate = {
  provider: "tmdb",
  providerId: "10378",
  kind: "movie",
  name: "Big Buck Bunny",
  year: 2008,
  overview: null,
  posterUrl: null,
};

const plan = (hand: Partial<typeof current>, candidates: ReadonlyArray<MetadataCandidate> = []) =>
  planFor({ currentTmdbId: "45745", current, hand: { ...current, ...hand }, candidates });

describe("parseYear", () => {
  it("takes whole years from 1870 to 2200", () => {
    expect(parseYear(" 2010 ")).toBe(2010);
    expect(parseYear("1869")).toBeNull();
    expect(parseYear("20.5")).toBeNull();
    expect(parseYear("")).toBeNull();
  });
});

describe("overridesFor", () => {
  it("sets only what changed", () => {
    expect(overridesFor("Sintel", 2010)).toEqual({ name: "Sintel", year: 2010 });
    expect(overridesFor(null, 2010)).toEqual({ year: 2010 });
    expect(overridesFor(null, null)).toEqual({});
  });
});

describe("planFor", () => {
  it("does nothing while the hand edit matches the title", () => {
    expect(plan({})).toMatchObject({ rematch: false, rename: false, redate: false });
  });

  it("renames and redates the current match by hand", () => {
    expect(plan({ name: "Sintel (Durian)", year: "2011" })).toMatchObject({
      rematch: false,
      rename: true,
      redate: true,
      year: 2011,
    });
  });

  it("rematches a chosen candidate without editing its own name and year", () => {
    const chosen = editFor({
      name: candidate.name,
      year: candidate.year,
      tmdbId: candidate.providerId,
    });

    expect(plan(chosen, [candidate])).toEqual({
      tmdbId: "10378",
      rematch: true,
      name: "Big Buck Bunny",
      year: 2008,
      rename: false,
      redate: false,
      yearInvalid: false,
    });
  });

  it("flags a year it cannot read", () => {
    expect(plan({ year: "soon" })).toMatchObject({ yearInvalid: true, redate: false });
  });
});
