import { Schema } from "effect";

/** The minimum viewer age a certification implies, from 0 (all ages) to 21. */
export const AgeRating = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 21 })).pipe(
  Schema.brand("AgeRating"),
);

/** A minimum viewer age. */
export type AgeRating = typeof AgeRating.Type;

const makeAgeRating = Schema.decodeSync(AgeRating);

const CERTIFICATION_AGES: ReadonlyMap<string, number> = new Map([
  ["G", 0],
  ["PG", 7],
  ["PG-13", 13],
  ["PG13", 13],
  ["R", 17],
  ["NC-17", 18],
  ["TV-Y", 0],
  ["TV-Y7", 7],
  ["TV-Y7-FV", 7],
  ["TV-G", 0],
  ["TV-PG", 10],
  ["TV-14", 14],
  ["TV-MA", 17],
  ["U", 0],
  ["12A", 12],
  ["R18", 18],
]);

const LEADING_AGE = /^(?:FSK|PEGI|TV|BBFC|IMDA|MA|M)?[\s-]*(\d{1,2})$/u;

/**
 * What NFO writers and other servers put before or after a rating: Kodi's `Rated ` prefix, a
 * country code with a colon or slash (`US:PG-13`, `gb/15`), and a trailing `+` (`R18+`, `16+`).
 */
const DECORATION = /^(?:RATED\s+)?(?:[A-Z]{2}\s*[:/]\s*)?(?<rating>.*?)\+?$/u;

/**
 * The minimum age for a certification string, or `undefined` when it is unrated or unknown.
 * Recognizes US film and TV ratings, BBFC ratings, and plain ages such as `12`, `16+`, or `FSK 16`,
 * with or without a `Rated ` or country prefix (`Rated PG-13`, `US:PG-13`, `gb/15`).
 */
export const ageRatingFromCertification = (certification: string): AgeRating | undefined => {
  const upper = certification.trim().toUpperCase();
  const normalized = DECORATION.exec(upper)?.groups?.["rating"] ?? upper;
  const known = CERTIFICATION_AGES.get(normalized);

  if (known !== undefined) return makeAgeRating(known);

  const match = LEADING_AGE.exec(normalized);
  const digits = match?.[1];

  if (digits === undefined) return undefined;
  const age = Number.parseInt(digits, 10);

  return age <= 21 ? makeAgeRating(age) : undefined;
};
