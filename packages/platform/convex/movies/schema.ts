import { defineTable } from "convex/server";
import { v } from "convex/values";

import {
  artwork,
  communityRating,
  creditKind,
  externalIds,
  externalSubtitle,
  importCheckpoint,
  importPlan,
  importedCounts,
  matchStatus,
  metadataOverrides,
  nullable,
  probe,
  ratings,
  showStatus,
  titleKind,
  trailer,
  trickplayState,
} from "./validators";

/**
 * The movies catalog, ported from old movies' tables (ADR 0024), and what each person keeps of it:
 * progress and their list, keyed by the person (D12, D36). Profiles, rooms, playback sessions, and
 * old movies' identity tables do not come over. A library's title total is its core item count,
 * and its episode and file totals are counters in `totals.ts`.
 */
export const moviesTables = {
  titles: defineTable({
    libraryId: v.id("libraries"),
    kind: titleKind,
    /** Identifies the title within its library across scans, such as `tmdb:603`. */
    matchKey: v.string(),
    name: v.string(),
    sortName: v.string(),
    /** Lowercased sort name for ordering; an admin's sort name wins over the scanned one. */
    sortKey: v.string(),
    year: nullable(v.number()),
    overview: nullable(v.string()),
    tagline: nullable(v.string()),
    genres: v.array(v.string()),
    certification: nullable(v.string()),
    /** The minimum viewer age the title asks for; null is unrated, which `hideUnrated` hides. */
    ageRating: nullable(v.number()),
    runtimeMs: nullable(v.number()),
    artwork,
    externalIds,
    matchStatus,
    /** Admin edits; presentation prefers them and scans never overwrite them. */
    overrides: v.optional(metadataOverrides),
    /** Files of this title (or its episodes) present on disk. Zero means unavailable. */
    presentFileCount: v.number(),
    /**
     * How many episode rows the title has, kept by every mutation that inserts one. Episodes never
     * move between titles and only the purge deletes them, after it has marked the title, so the
     * purge takes the title's episodes out of the library's total with this one number.
     */
    episodeCount: v.number(),
    /**
     * Moves each time an admin's match is applied. A metadata job carries the generation it was
     * asked for, and its result is dropped once the generation moved on, so a refresh that read
     * the title before a manual match can never overwrite it (ADR 0012).
     */
    matchGeneration: v.number(),
    addedAt: v.number(),
    updatedAt: v.number(),
    searchText: v.string(),
    /**
     * Unique per row, set once by the movies writer: the last field of the indexes a list walks,
     * so its cursor names one exact row however many share the fields before it (ADR 0005).
     */
    tie: v.string(),
    originalName: v.optional(nullable(v.string())),
    releaseDate: v.optional(nullable(v.string())),
    status: v.optional(nullable(showStatus)),
    originalLanguage: v.optional(nullable(v.string())),
    studios: v.optional(v.array(v.string())),
    countries: v.optional(v.array(v.string())),
    tags: v.optional(v.array(v.string())),
    ratings: v.optional(ratings),
    trailer: v.optional(nullable(trailer)),
    /** TMDB ids the provider recommends, best first. */
    recommendations: v.optional(v.array(v.string())),
    /** Digest of the title's own credits, so unchanged rescans skip rewriting them. */
    creditsHash: v.optional(v.string()),
    /** Digest of the collection the title's metadata names, likewise. */
    collectionHash: v.optional(v.string()),
    /**
     * Set when the purge starts deleting the title, in the mutation that deletes its first rows,
     * with `matchKey` moved aside to `purgingKey`. Scans and writers never reuse it, so a file
     * that returns builds a new title while the purge finishes this one (ADR 0024).
     */
    purging: v.optional(v.literal(true)),
  })
    .index("by_library_match", ["libraryId", "matchKey"])
    .index("by_kind_tmdb", ["kind", "externalIds.tmdb"])
    .index("by_library_status", ["libraryId", "matchStatus"])
    .index("by_library_sort", ["libraryId", "sortKey"])
    .index("by_library_added", ["libraryId", "addedAt", "tie"])
    .index("by_library_kind_added", ["libraryId", "kind", "addedAt", "tie"])
    .index("by_library_year", ["libraryId", "year"])
    .index("by_sort", ["sortKey"])
    .index("by_added", ["addedAt"])
    .index("by_year", ["year"])
    .index("by_kind_sort", ["kind", "sortKey"])
    .index("by_kind_added", ["kind", "addedAt"])
    .index("by_kind_year", ["kind", "year"])
    .searchIndex("search_text", { searchField: "searchText", filterFields: ["libraryId", "kind"] }),

  /**
   * One row per title and genre, so browsing a genre reads only its titles: Convex cannot index
   * array members. Rows copy the title's sort fields; `catalog.ts` keeps them in step with every
   * write of a title's genres or sort fields.
   */
  titleGenres: defineTable({
    titleId: v.id("titles"),
    libraryId: v.id("libraries"),
    /** The genre, trimmed and lowercased. */
    genre: v.string(),
    kind: titleKind,
    sortKey: v.string(),
    addedAt: v.number(),
    year: nullable(v.number()),
  })
    .index("by_title", ["titleId"])
    .index("by_library_genre_sort", ["libraryId", "genre", "sortKey"])
    .index("by_library_genre_added", ["libraryId", "genre", "addedAt"])
    .index("by_library_genre_year", ["libraryId", "genre", "year"])
    .index("by_genre_sort", ["genre", "sortKey"])
    .index("by_genre_added", ["genre", "addedAt"])
    .index("by_genre_year", ["genre", "year"])
    .index("by_kind_genre_sort", ["kind", "genre", "sortKey"])
    .index("by_kind_genre_added", ["kind", "genre", "addedAt"])
    .index("by_kind_genre_year", ["kind", "genre", "year"]),

  seasons: defineTable({
    titleId: v.id("titles"),
    seasonNumber: v.number(),
    name: v.string(),
    poster: nullable(v.string()),
    episodeCount: v.number(),
    externalIds,
  }).index("by_title_number", ["titleId", "seasonNumber"]),

  episodes: defineTable({
    titleId: v.id("titles"),
    seasonId: v.id("seasons"),
    seasonNumber: v.number(),
    episodeNumber: v.number(),
    name: v.string(),
    overview: nullable(v.string()),
    airDate: nullable(v.string()),
    runtimeMs: nullable(v.number()),
    still: nullable(v.string()),
    presentFileCount: v.number(),
    rating: nullable(communityRating),
    externalIds,
    /** Digest of the episode's guest stars and crew, so unchanged rescans skip rewriting them. */
    creditsHash: v.optional(v.string()),
  }).index("by_title_order", ["titleId", "seasonNumber", "episodeNumber"]),

  /**
   * Cast and crew, shared by every library. A person is identified by `personKey`: `tmdb:<id>`
   * when TMDB knows them, else `imdb:<id>`, else `name:<normalized name>`. A name-keyed person is
   * upgraded in place once a TMDB id turns up, so their credits keep pointing at one row.
   */
  people: defineTable({
    personKey: v.string(),
    /**
     * `name:<normalized name>` from the name a scan first sent, bounded as keys are, whatever
     * their key became: a credit without ids finds the person by it, never by the stored name,
     * which the fitter may have cut.
     */
    nameKey: v.string(),
    name: v.string(),
    sortKey: v.string(),
    externalIds,
    /** Photo artwork key. */
    profile: nullable(v.string()),
    biography: nullable(v.string()),
    birthDate: nullable(v.string()),
    deathDate: nullable(v.string()),
    birthPlace: nullable(v.string()),
    knownFor: nullable(v.string()),
    /** When a person or metadata job last wrote their details; null until then. */
    detailsFetchedAt: nullable(v.number()),
    /** When someone last asked for their details, so a page opened again queues no new job. */
    detailsRequestedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_key", ["personKey"])
    .index("by_name_key", ["nameKey"])
    .index("by_tmdb", ["externalIds.tmdb"])
    .searchIndex("search_name", { searchField: "name" }),

  /** One person's credit on a title (`episodeId` null) or on one episode of a show. */
  credits: defineTable({
    titleId: v.id("titles"),
    episodeId: nullable(v.id("episodes")),
    personId: v.id("people"),
    kind: creditKind,
    role: nullable(v.string()),
    order: v.number(),
    /**
     * Unique per row, set once by the movies writer: the last field of the indexes a list walks,
     * so its cursor names one exact row however many share the fields before it (ADR 0005).
     */
    tie: v.string(),
  })
    .index("by_title_episode", ["titleId", "episodeId", "order"])
    .index("by_person", ["personId", "tie"]),

  /** A file a scan found, the title and episode it plays, and what ffprobe saw in it. */
  mediaFiles: defineTable({
    libraryId: v.id("libraries"),
    titleId: v.id("titles"),
    episodeId: nullable(v.id("episodes")),
    path: v.string(),
    sizeBytes: v.number(),
    mtimeMs: v.number(),
    probe,
    externalSubtitles: v.array(externalSubtitle),
    versionName: nullable(v.string()),
    hdr: v.boolean(),
    /** A scan did not find it; its title, episode, and history stay until it returns. */
    missing: v.boolean(),
    missingSince: v.optional(v.number()),
    addedAt: v.number(),
    /** Scrub thumbnails; absent until a trickplay job is queued for this file. */
    trickplay: v.optional(trickplayState),
    /** Digest of the companions the scan read (NFO, artwork, subtitles), to notice their edits. */
    sidecarDigest: nullable(v.string()),
  })
    .index("by_library_path", ["libraryId", "path"])
    .index("by_library_missing", ["libraryId", "missing"])
    .index("by_title", ["titleId"])
    .index("by_episode", ["episodeId"]),

  /** Named sets of titles: TMDB collections, NFO sets, and box sets imported from elsewhere. */
  collections: defineTable({
    name: v.string(),
    sortKey: v.string(),
    /**
     * Identifies a collection across runs: `jellyfin:<server>:<id>` or `plex:…` when imported,
     * `tmdb:<id>` for a TMDB collection, `set:<name>` for an NFO set.
     */
    sourceKey: nullable(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    overview: nullable(v.string()),
    poster: nullable(v.string()),
    backdrop: nullable(v.string()),
    /**
     * Unique per row, set once by the movies writer: the last field of the indexes a list walks,
     * so its cursor names one exact row however many share the fields before it (ADR 0005).
     */
    tie: v.string(),
  })
    .index("by_source_key", ["sourceKey"])
    .index("by_sort", ["sortKey", "tie"]),

  collectionItems: defineTable({
    collectionId: v.id("collections"),
    titleId: v.id("titles"),
    position: v.number(),
    /** `metadata` members come from a title's metadata; imports leave them alone. */
    source: v.union(v.literal("metadata"), v.literal("import")),
  })
    .index("by_collection_position", ["collectionId", "position"])
    .index("by_title", ["titleId"]),

  /**
   * One person's progress through a movie (`episodeId` null) or an episode, and so their watch
   * history. A row stays when its title is purged; reads skip it, as old movies did.
   */
  watchProgress: defineTable({
    userId: v.id("users"),
    titleId: v.id("titles"),
    episodeId: nullable(v.id("episodes")),
    /** The version last played, which the next start prefers while it is on disk. */
    fileId: nullable(v.id("mediaFiles")),
    positionMs: v.number(),
    durationMs: v.number(),
    /** Stays set until the person marks the item unwatched, so a rewatch keeps it. */
    watched: v.boolean(),
    updatedAt: v.number(),
    lastPlayedAt: v.number(),
    /**
     * The playback that last reported, its id and start time from `movies.play.start`, so a
     * report from an older start cannot drag a newer one's position back.
     */
    playId: v.optional(v.string()),
    playStartedAt: v.optional(v.number()),
  })
    .index("by_user_item", ["userId", "titleId", "episodeId"])
    .index("by_user_title_played", ["userId", "titleId", "lastPlayedAt"])
    .index("by_user_played", ["userId", "lastPlayedAt"]),

  myList: defineTable({
    userId: v.id("users"),
    titleId: v.id("titles"),
    addedAt: v.number(),
  })
    .index("by_user_title", ["userId", "titleId"])
    .index("by_user_added", ["userId", "addedAt"]),

  /**
   * How many times a person's history of one title has changed: every mark and every progress
   * report moves it. A scheduled page of marking a whole show carries the generation it was asked
   * at and writes nothing once it moved, so it never undoes a newer change.
   */
  watchMarks: defineTable({
    userId: v.id("users"),
    titleId: v.id("titles"),
    generation: v.number(),
    /**
     * When the person last marked the whole title watched or unwatched. An import defers to it:
     * source progress played before it is older than the person's own word (ADR 0012).
     */
    markedAt: v.optional(v.number()),
  }).index("by_user_title", ["userId", "titleId"]),

  /**
   * A Jellyfin or Plex import's plan, where it resumes, and what it wrote, keyed by its core
   * `imports` row (ADR 0012). Each write of the import moves the checkpoint in its own mutation, so
   * a restarted import goes on from exactly where the last one stopped.
   */
  importPlans: defineTable({
    importId: v.id("imports"),
    /** Who started it: an owner or an admin when it started. */
    requestedBy: v.id("users"),
    plan: importPlan,
    /** The movies libraries covering the plan's folders, found or added; at most 64. */
    libraryIds: v.array(v.id("libraries")),
    checkpoint: importCheckpoint,
    imported: importedCounts,
  }).index("by_import", ["importId"]),
};
