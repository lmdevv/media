import { YOUTUBE_KEY_PATTERN } from "@media/contracts/models/catalog";

import type { Credit, CreditKind, ExternalIds, Ratings, TitleKind } from "./catalog";

/** One site's score, ready to draw. */
export interface Score {
  readonly site: "imdb" | "rottenTomatoes" | "metacritic" | "tmdb";
  /** The site's name, for screen readers and tooltips. */
  readonly label: string;
  /** The short mark drawn before the value. */
  readonly mark: string;
  /** `7.9`, `88%`, or `73`. */
  readonly value: string;
}

const tenths = (value: number): string => value.toFixed(1);

/** The scores a title has, IMDb first, the way the title page lists them. */
export const scoresOf = (ratings: Ratings): ReadonlyArray<Score> => [
  ...(ratings.imdb === null
    ? []
    : [{ site: "imdb", label: "IMDb", mark: "IMDb", value: tenths(ratings.imdb.value) } as const]),
  ...(ratings.rottenTomatoes === null
    ? []
    : [
        {
          site: "rottenTomatoes",
          label: "Rotten Tomatoes",
          mark: "RT",
          value: `${ratings.rottenTomatoes}%`,
        } as const,
      ]),
  ...(ratings.metacritic === null
    ? []
    : [
        {
          site: "metacritic",
          label: "Metacritic",
          mark: "MC",
          value: String(ratings.metacritic),
        } as const,
      ]),
  ...(ratings.tmdb === null
    ? []
    : [{ site: "tmdb", label: "TMDB", mark: "TMDB", value: tenths(ratings.tmdb.value) } as const]),
];

/** A link to a title or person at a metadata site. */
export interface ExternalLink {
  readonly label: "IMDb" | "TMDB" | "TVDB";
  readonly href: string;
}

const IMDB_TITLE = /^tt\d+$/u;

const IMDB_NAME = /^nm\d+$/u;

const NUMERIC = /^\d+$/u;

/** Links to a title's pages at IMDb, TMDB, and TVDB, for the IDs it has. */
export const titleLinks = (kind: TitleKind, ids: ExternalIds): ReadonlyArray<ExternalLink> => [
  ...(ids.imdb !== null && IMDB_TITLE.test(ids.imdb)
    ? [{ label: "IMDb", href: `https://www.imdb.com/title/${ids.imdb}/` } as const]
    : []),
  ...(ids.tmdb !== null && NUMERIC.test(ids.tmdb)
    ? [
        {
          label: "TMDB",
          href: `https://www.themoviedb.org/${kind === "movie" ? "movie" : "tv"}/${ids.tmdb}`,
        } as const,
      ]
    : []),
  ...(ids.tvdb !== null && NUMERIC.test(ids.tvdb)
    ? [
        {
          label: "TVDB",
          href: `https://thetvdb.com/dereferrer/${kind === "movie" ? "movie" : "series"}/${ids.tvdb}`,
        } as const,
      ]
    : []),
];

/** Links to a person's pages at IMDb and TMDB. */
export const personLinks = (ids: ExternalIds): ReadonlyArray<ExternalLink> => [
  ...(ids.imdb !== null && IMDB_NAME.test(ids.imdb)
    ? [{ label: "IMDb", href: `https://www.imdb.com/name/${ids.imdb}/` } as const]
    : []),
  ...(ids.tmdb !== null && NUMERIC.test(ids.tmdb)
    ? [{ label: "TMDB", href: `https://www.themoviedb.org/person/${ids.tmdb}` } as const]
    : []),
];

const CREW_HEADINGS: Readonly<Record<CreditKind, string>> = {
  actor: "Cast",
  "guest-star": "Guest stars",
  creator: "Created by",
  director: "Directed by",
  writer: "Written by",
  producer: "Produced by",
  composer: "Music by",
};

/** `Directed by` and the people credited so, for each kind in `kinds` that has any. */
export const creditLines = (
  credits: ReadonlyArray<Credit>,
  kinds: ReadonlyArray<CreditKind>,
): ReadonlyArray<{ readonly heading: string; readonly people: ReadonlyArray<Credit> }> =>
  kinds.flatMap((kind) => {
    const seen = new Set<string>();

    const people = credits.filter((credit) => {
      if (credit.kind !== kind || seen.has(credit.personId)) return false;
      seen.add(credit.personId);

      return true;
    });

    return people.length === 0 ? [] : [{ heading: CREW_HEADINGS[kind], people }];
  });

const JOB_NAMES: Readonly<Record<CreditKind, string>> = {
  actor: "Cast",
  "guest-star": "Guest star",
  creator: "Creator",
  director: "Director",
  writer: "Writer",
  producer: "Producer",
  composer: "Composer",
};

/** What a person did, for their page: `Ripley`, `Director`, or `Guest star · 3 episodes`. */
export const creditRole = (credit: {
  readonly kind: CreditKind;
  readonly role: string | null;
  readonly episodeCount: number;
}): string => {
  const what =
    credit.kind === "actor" || credit.kind === "guest-star" || credit.kind === "writer"
      ? (credit.role ?? JOB_NAMES[credit.kind])
      : JOB_NAMES[credit.kind];

  return credit.episodeCount > 1 ? `${what} · ${credit.episodeCount} episodes` : what;
};

/**
 * The line under a title on a person's page: `as Ellen Ripley` for a character, else the job, such
 * as `Director` or `Guest star · 3 episodes`.
 */
export const personRole = (credit: {
  readonly kind: CreditKind;
  readonly role: string | null;
  readonly episodeCount: number;
}): string =>
  (credit.kind === "actor" || credit.kind === "guest-star") && credit.role !== null
    ? creditRole({ ...credit, role: `as ${credit.role}` })
    : creditRole(credit);

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

const longDate = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/** `March 31, 1999` for `1999-03-31`; anything else as given. */
export const formatDate = (iso: string): string =>
  ISO_DATE.test(iso) ? longDate.format(Date.parse(`${iso}T00:00:00Z`)) : iso;

/** Whole years from `from` to `to`, both `YYYY-MM-DD`. */
export const yearsBetween = (from: string, to: string): number | null => {
  const start = ISO_DATE.exec(from);
  const end = ISO_DATE.exec(to);

  if (start === null || end === null) return null;

  const [, fromYear = "0", fromMonth = "0", fromDay = "0"] = start;
  const [, toYear = "0", toMonth = "0", toDay = "0"] = end;

  const beforeBirthday =
    Number(toMonth) < Number(fromMonth) ||
    (Number(toMonth) === Number(fromMonth) && Number(toDay) < Number(fromDay));

  return Number(toYear) - Number(fromYear) - (beforeBirthday ? 1 : 0);
};

const languages = new Intl.DisplayNames(["en"], { type: "language" });

/** `English` for `en`; the code itself when the browser does not know it. */
export const languageName = (code: string): string => {
  try {
    return languages.of(code) ?? code;
  } catch {
    return code;
  }
};

/** The privacy-enhanced YouTube player for a trailer; the only frame the CSP allows. */
export const trailerEmbedUrl = (key: string): string | undefined =>
  YOUTUBE_KEY_PATTERN.test(key)
    ? `https://www.youtube-nocookie.com/embed/${key}?autoplay=1&rel=0&modestbranding=1`
    : undefined;

/** A decade filter, such as the 1990s from 1990 to 1999. */
export interface Decade {
  readonly label: string;
  readonly from: number;
  readonly to: number;
}

/** Decades from `latestYear`'s back to the 1920s, newest first. */
export const decadesUntil = (latestYear: number): ReadonlyArray<Decade> =>
  Array.from({ length: Math.floor(latestYear / 10) - 192 + 1 }, (_, index) => {
    const from = (Math.floor(latestYear / 10) - index) * 10;

    return { label: `${from}s`, from, to: from + 9 };
  });
