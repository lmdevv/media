import { YOUTUBE_KEY_PATTERN } from "@media/contracts/models/catalog";
import { Schema } from "effect";

import { childrenNamed, childText, parseXml, type XmlElement } from "./xml.ts";

/** Provider IDs found in local metadata. */
export const ExternalIds = Schema.Struct({
  tmdb: Schema.optional(Schema.String),
  imdb: Schema.optional(Schema.String),
  tvdb: Schema.optional(Schema.String),
});

/** Provider IDs found in local metadata. */
export interface ExternalIds extends Schema.Schema.Type<typeof ExternalIds> {}

/** Whether a show still airs; `ShowStatus` in contracts. */
export const ShowStatus = Schema.Literals([
  "returning",
  "ended",
  "canceled",
  "in-production",
  "planned",
]);

/** Whether a show still airs. */
export type ShowStatus = typeof ShowStatus.Type;

const STATUSES: ReadonlyMap<string, ShowStatus> = new Map([
  ["returning series", "returning"],
  ["returning", "returning"],
  ["continuing", "returning"],
  ["ended", "ended"],
  ["canceled", "canceled"],
  ["cancelled", "canceled"],
  ["in production", "in-production"],
  ["planned", "planned"],
  ["pilot", "planned"],
]);

/** A show status as TMDB, Kodi, or Jellyfin spell it (`Returning Series`, `Continuing`, `Ended`). */
export const showStatusOf = (text: string | undefined): ShowStatus | undefined =>
  text === undefined ? undefined : STATUSES.get(text.trim().toLowerCase());

const YOUTUBE_URLS: ReadonlyArray<RegExp> = [
  /[?&]video_?id=([\w-]{6,20})/u,
  /youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)([\w-]{6,20})/u,
  /youtu\.be\/([\w-]{6,20})/u,
];

/**
 * The YouTube video ID in a trailer reference: a bare ID, a YouTube URL, or Kodi's
 * `plugin://plugin.video.youtube/?action=play_video&videoid=…`.
 */
export const youtubeKeyOf = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  const trimmed = text.trim();

  if (YOUTUBE_KEY_PATTERN.test(trimmed)) return trimmed;

  return YOUTUBE_URLS.map((pattern) => pattern.exec(trimmed)?.[1]).find((key) => key !== undefined);
};

/** A community score with its vote count, on a 0–10 scale. */
export const Score = Schema.Struct({
  value: Schema.Finite,
  votes: Schema.optional(Schema.Int),
});

/** A community score with its vote count. */
export interface Score extends Schema.Schema.Type<typeof Score> {}

/** Scores by site. Rotten Tomatoes and Metacritic are 0–100. */
export const SiteRatings = Schema.Struct({
  tmdb: Schema.optional(Score),
  imdb: Schema.optional(Score),
  rottenTomatoes: Schema.optional(Schema.Int),
  metacritic: Schema.optional(Schema.Int),
});

/** Scores by site. */
export interface SiteRatings extends Schema.Schema.Type<typeof SiteRatings> {}

/** One `<actor>` of an NFO. */
export const NfoActor = Schema.Struct({
  name: Schema.String,
  role: Schema.optional(Schema.String),
  order: Schema.optional(Schema.Int),
  /** An image URL, usually at TMDB. */
  thumb: Schema.optional(Schema.String),
  ids: ExternalIds,
});

/** One `<actor>` of an NFO. */
export interface NfoActor extends Schema.Schema.Type<typeof NfoActor> {}

const NfoSet = Schema.Struct({
  name: Schema.String,
  overview: Schema.optional(Schema.String),
  /** TMDB collection ID, from Jellyfin's `tmdbcolid` attribute. */
  tmdb: Schema.optional(Schema.String),
});

interface NfoSet extends Schema.Schema.Type<typeof NfoSet> {}

/** Metadata read from an NFO file. Every field is optional; absent means "not stated locally". */
export const LocalMetadata = Schema.Struct({
  kind: Schema.Literals(["movie", "show", "episode"]),
  title: Schema.optional(Schema.String),
  originalTitle: Schema.optional(Schema.String),
  sortTitle: Schema.optional(Schema.String),
  year: Schema.optional(Schema.Int),
  /** First release or air date, `YYYY-MM-DD`. */
  releaseDate: Schema.optional(Schema.String),
  plot: Schema.optional(Schema.String),
  tagline: Schema.optional(Schema.String),
  runtimeMinutes: Schema.optional(Schema.Int),
  /** Certification such as `PG-13` or `TV-MA`, from `<mpaa>` or `<certification>`. */
  contentRating: Schema.optional(Schema.String),
  /** Community rating on a 0–10 scale. */
  rating: Schema.optional(Schema.Finite),
  /** Scores by site, from `<ratings>`. */
  ratings: SiteRatings,
  genres: Schema.Array(Schema.String),
  studios: Schema.Array(Schema.String),
  countries: Schema.Array(Schema.String),
  tags: Schema.Array(Schema.String),
  ids: ExternalIds,
  season: Schema.optional(Schema.Int),
  episode: Schema.optional(Schema.Int),
  /** Cast in billing order. */
  actors: Schema.Array(NfoActor),
  directors: Schema.Array(Schema.String),
  /** From `<credits>` and `<writer>`. */
  writers: Schema.Array(Schema.String),
  collection: Schema.optional(NfoSet),
  /** A YouTube video ID from `<trailer>`. */
  trailer: Schema.optional(Schema.String),
  status: Schema.optional(ShowStatus),
});

/** Metadata read from an NFO file. */
export interface LocalMetadata extends Schema.Schema.Type<typeof LocalMetadata> {}

/** Which NFO a caller expects; it also types URL-only NFO files. */
export type NfoKind = LocalMetadata["kind"];

const ROOTS: ReadonlyMap<string, NfoKind> = new Map([
  ["movie", "movie"],
  ["tvshow", "show"],
  ["episodedetails", "episode"],
]);

const IMDB_ID = /\b(tt\d{7,})\b/;

const TMDB_URL = /themoviedb\.org\/(?:movie|tv)\/(\d+)/;

const TVDB_URL = /thetvdb\.com\/.*?(?:id=|series\/)(\d+)/;

const integer = (text: string | undefined): number | undefined => {
  const value = text === undefined ? Number.NaN : Number.parseInt(text, 10);

  return Number.isFinite(value) ? value : undefined;
};

const decimal = (text: string | undefined): number | undefined => {
  const value = text === undefined ? Number.NaN : Number.parseFloat(text.replace(",", "."));

  return Number.isFinite(value) ? value : undefined;
};

const isoDate = (text: string | undefined): string | undefined =>
  text !== undefined && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : undefined;

const texts = (element: XmlElement, name: string): ReadonlyArray<string> =>
  childrenNamed(element, name)
    .flatMap((child) => child.text.split(" / "))
    .map((text) => text.trim())
    .filter((text) => text !== "");

const ratingOf = (element: XmlElement): number | undefined => {
  const ratings = childrenNamed(element, "ratings").flatMap((group) =>
    childrenNamed(group, "rating"),
  );

  const chosen =
    ratings.find((rating) => rating.attributes.get("default") === "true") ?? ratings[0];

  if (chosen !== undefined) {
    const value = decimal(childText(chosen, "value"));
    const max = decimal(chosen.attributes.get("max")) ?? 10;

    if (value !== undefined && max > 0) return Math.round((value / max) * 100) / 10;
  }

  return decimal(childText(element, "rating"));
};

const percent = (value: number, max: number): number =>
  Math.round(Math.min(100, Math.max(0, (value / max) * 100)));

const tenths = (value: number, max: number): number => Math.round((value / max) * 100) / 10;

const siteOf = (name: string): keyof SiteRatings | undefined => {
  const folded = name.toLowerCase().replaceAll(/\s+/gu, "");

  if (folded === "imdb") return "imdb";

  if (folded === "themoviedb" || folded === "tmdb") return "tmdb";

  if (folded.startsWith("tomatometer") || folded === "rottentomatoes") return "rottenTomatoes";

  return folded === "metacritic" ? "metacritic" : undefined;
};

/** `<ratings><rating name="imdb" max="10"><value>7.5</value><votes>100</votes></rating>`. */
const siteRatingsOf = (element: XmlElement): SiteRatings => {
  const found = childrenNamed(element, "ratings")
    .flatMap((group) => childrenNamed(group, "rating"))
    .flatMap((rating) => {
      const site = siteOf(rating.attributes.get("name") ?? "");
      const value = decimal(childText(rating, "value"));
      const max = decimal(rating.attributes.get("max")) ?? 10;
      const votes = integer(childText(rating, "votes")?.replaceAll(/[,.\s]/gu, ""));

      return site === undefined || value === undefined || max <= 0
        ? []
        : [{ site, value, max, votes }];
    });

  const first = (site: keyof SiteRatings) => found.find((rating) => rating.site === site);

  const score = (site: "tmdb" | "imdb"): Score | undefined => {
    const rating = first(site);

    if (rating === undefined) return undefined;
    const value = tenths(rating.value, rating.max);

    return rating.votes === undefined ? { value } : { value, votes: rating.votes };
  };

  const scaled = (site: "rottenTomatoes" | "metacritic"): number | undefined => {
    const rating = first(site);

    return rating === undefined ? undefined : percent(rating.value, rating.max);
  };

  return {
    tmdb: score("tmdb"),
    imdb: score("imdb"),
    rottenTomatoes: scaled("rottenTomatoes"),
    metacritic: scaled("metacritic"),
  };
};

/** A `<director>` or `<credits>` entry: plain text, or a `<name>` child as Emby writes it. */
const namesOf = (element: XmlElement, name: string): ReadonlyArray<string> =>
  childrenNamed(element, name)
    .map((child) => childText(child, "name") ?? child.text.trim())
    .flatMap((text) => text.split(" / "))
    .map((text) => text.trim())
    .filter((text) => text !== "");

const actorsOf = (element: XmlElement): ReadonlyArray<NfoActor> =>
  childrenNamed(element, "actor")
    .flatMap((actor, index): ReadonlyArray<NfoActor> => {
      const name = childText(actor, "name");

      if (name === undefined) return [];
      const type = childText(actor, "type")?.toLowerCase();

      // Jellyfin lists directors and writers as typed `<actor>` elements too.
      if (type !== undefined && type !== "actor" && type !== "gueststar") return [];
      const order = integer(childText(actor, "order") ?? childText(actor, "sortorder"));

      return [
        {
          name,
          role: childText(actor, "role"),
          order: order ?? index,
          thumb: childText(actor, "thumb"),
          ids: {
            tmdb: childText(actor, "tmdbid"),
            imdb: childText(actor, "imdbid"),
            tvdb: childText(actor, "tvdbid"),
          },
        },
      ];
    })
    .toSorted((left, right) => (left.order ?? 0) - (right.order ?? 0));

/** `<set>Alien Collection</set>`, or `<set tmdbcolid="8091"><name>…</name><overview>…</overview></set>`. */
const setOf = (element: XmlElement): NfoSet | undefined => {
  const [set] = childrenNamed(element, "set");

  if (set === undefined) return undefined;
  const name = childText(set, "name") ?? (set.children.length === 0 ? set.text.trim() : "");

  if (name === "") return undefined;

  const tmdb = set.attributes.get("tmdbcolid")?.trim();

  return { name, overview: childText(set, "overview"), tmdb: tmdb === "" ? undefined : tmdb };
};

const idsOf = (element: XmlElement): ExternalIds => {
  const unique = new Map<string, string>();

  for (const id of childrenNamed(element, "uniqueid")) {
    const type = id.attributes.get("type")?.toLowerCase();
    const value = id.text.trim();

    if (type !== undefined && value !== "" && !unique.has(type)) unique.set(type, value);
  }

  const legacyId = childText(element, "id");

  return {
    tmdb: unique.get("tmdb") ?? childText(element, "tmdbid"),
    imdb:
      unique.get("imdb") ??
      childText(element, "imdbid") ??
      (legacyId !== undefined && IMDB_ID.test(legacyId) ? legacyId : undefined),
    tvdb: unique.get("tvdb") ?? childText(element, "tvdbid"),
  };
};

const fromElement = (kind: NfoKind, element: XmlElement): LocalMetadata => {
  const releaseDate = isoDate(childText(element, "premiered") ?? childText(element, "aired"));
  const runtime = integer(childText(element, "runtime"));

  return {
    kind,
    title: childText(element, "title"),
    originalTitle: childText(element, "originaltitle"),
    sortTitle: childText(element, "sorttitle"),
    year: integer(childText(element, "year")) ?? integer(releaseDate?.slice(0, 4)),
    releaseDate,
    plot: childText(element, "plot") ?? childText(element, "outline"),
    tagline: childText(element, "tagline"),
    runtimeMinutes: runtime !== undefined && runtime > 0 ? runtime : undefined,
    contentRating: childText(element, "mpaa") ?? childText(element, "certification"),
    rating: ratingOf(element),
    ratings: siteRatingsOf(element),
    genres: texts(element, "genre"),
    studios: texts(element, "studio"),
    countries: texts(element, "country"),
    tags: texts(element, "tag"),
    ids: idsOf(element),
    season: integer(childText(element, "season")),
    episode: integer(childText(element, "episode")),
    actors: actorsOf(element),
    directors: namesOf(element, "director"),
    writers: [...new Set([...namesOf(element, "credits"), ...namesOf(element, "writer")])],
    collection: setOf(element),
    trailer: youtubeKeyOf(childText(element, "trailer")),
    status: showStatusOf(childText(element, "status")),
  };
};

const fromUrls = (kind: NfoKind, text: string): LocalMetadata | undefined => {
  const imdb = IMDB_ID.exec(text)?.[1];
  const tmdb = TMDB_URL.exec(text)?.[1];
  const tvdb = TVDB_URL.exec(text)?.[1];

  if (imdb === undefined && tmdb === undefined && tvdb === undefined) return undefined;

  return {
    kind,
    ratings: {},
    genres: [],
    studios: [],
    countries: [],
    tags: [],
    ids: { tmdb, imdb, tvdb },
    actors: [],
    directors: [],
    writers: [],
  };
};

/**
 * Parses an NFO file of the expected kind. Returns `undefined` when the file has neither a
 * matching XML root nor a provider URL. For multi-episode NFO files, `episode` selects the
 * matching `<episodedetails>` block; the first one is used otherwise.
 */
export const parseNfo = (
  text: string,
  expected: NfoKind,
  episode?: number,
): LocalMetadata | undefined => {
  const roots = parseXml(text).filter((element) => ROOTS.get(element.name) === expected);

  const chosen =
    (episode === undefined
      ? undefined
      : roots.find((element) => integer(childText(element, "episode")) === episode)) ?? roots[0];

  return chosen === undefined ? fromUrls(expected, text) : fromElement(expected, chosen);
};
