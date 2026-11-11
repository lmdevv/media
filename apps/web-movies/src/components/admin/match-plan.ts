import type { MetadataCandidate } from "@media/contracts/models/catalog";

import type { MetadataOverrides } from "./types";

/** The title, year, and TMDB ID typed under “Or edit by hand”. */
export interface HandEdit {
  readonly name: string;
  readonly year: string;
  readonly tmdbId: string;
}

/** The hand-edit fields filled from a title or a candidate. */
export const editFor = (source: {
  readonly name: string;
  readonly year: number | null;
  readonly tmdbId: string | null;
}): HandEdit => ({
  name: source.name,
  year: source.year === null ? "" : String(source.year),
  tmdbId: source.tmdbId ?? "",
});

/** The overrides that set a new name, a new year, both, or neither. */
export const overridesFor = (name: string | null, year: number | null): MetadataOverrides => {
  if (name !== null && year !== null) return { name, year };

  if (name !== null) return { name };

  return year === null ? {} : { year };
};

/** A typed year from 1870 to 2200, or null for anything else. */
export const parseYear = (text: string): number | null => {
  const year = Number(text.trim());

  return text.trim() !== "" && Number.isInteger(year) && year >= 1870 && year <= 2200 ? year : null;
};

/** What Apply match does: match another TMDB entry, rename, and change the year, as each applies. */
export interface MatchPlan {
  readonly tmdbId: string;
  readonly rematch: boolean;
  readonly name: string;
  readonly year: number | null;
  readonly rename: boolean;
  readonly redate: boolean;
  readonly yearInvalid: boolean;
}

/**
 * Compares the hand edit with what the title will hold after the match: the current title, or the
 * chosen candidate when the TMDB ID changes. Only fields that differ from that are edited.
 */
export const planFor = ({
  currentTmdbId,
  current,
  hand,
  candidates,
}: {
  readonly currentTmdbId: string | null;
  readonly current: HandEdit;
  readonly hand: HandEdit;
  readonly candidates: ReadonlyArray<MetadataCandidate>;
}): MatchPlan => {
  const tmdbId = hand.tmdbId.trim();
  const rematch = tmdbId !== "" && tmdbId !== (currentTmdbId ?? "");
  const base = candidates.find((each) => each.providerId === tmdbId);

  const expected = rematch
    ? editFor({ name: base?.name ?? hand.name, year: base?.year ?? null, tmdbId })
    : current;

  const name = hand.name.trim();
  const year = parseYear(hand.year);

  return {
    tmdbId,
    rematch,
    name,
    year,
    rename: name !== "" && name !== expected.name,
    redate: year !== null && hand.year.trim() !== expected.year,
    yearInvalid: hand.year.trim() !== "" && year === null,
  };
};
