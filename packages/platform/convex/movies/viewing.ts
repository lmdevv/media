import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import type { TitleViewer } from "./access";
import { presentEpisode, presentProgress, presentTitleCard } from "./present";
import type { ContinueItem, Episode } from "./present";

const WATCHED_FRACTION = 0.9;

/** Whether a position counts as finished. An unknown duration never finishes by position. */
export const reachedEnd = (positionMs: number, durationMs: number): boolean =>
  durationMs > 0 && positionMs >= durationMs * WATCHED_FRACTION;

/**
 * Whether a progress row counts as finished: played to the end, or marked watched without a
 * position in progress. A rewatch in progress is not finished, so it shows up to resume.
 */
export const isFinished = (row: Doc<"watchProgress">): boolean =>
  reachedEnd(row.positionMs, row.durationMs) || (row.watched && row.positionMs <= 0);

/** Loads a person's progress through a movie (`episodeId` null) or an episode. */
export const findProgress = (
  db: DatabaseReader,
  userId: Id<"users">,
  titleId: Id<"titles">,
  episodeId: Id<"episodes"> | null,
): Promise<Doc<"watchProgress"> | null> =>
  db
    .query("watchProgress")
    .withIndex("by_user_item", (q) =>
      q.eq("userId", userId).eq("titleId", titleId).eq("episodeId", episodeId),
    )
    .unique();

/** An episode with the person's progress through it, read here. */
export const presentEpisodeFor = async (
  db: DatabaseReader,
  userId: Id<"users">,
  episode: Doc<"episodes">,
): Promise<Episode> =>
  presentEpisode(episode, await findProgress(db, userId, episode.titleId, episode._id));

/** The playback a report comes from: its auth session and when `movies.play.start` ran. */
export interface PlayOrigin {
  readonly sessionId: Id<"authSessions">;
  readonly startedAt: number;
}

/** A progress write from a playback report, an offline report, or a manual mark. */
export interface ProgressWrite {
  readonly userId: Id<"users">;
  readonly titleId: Id<"titles">;
  readonly episodeId: Id<"episodes"> | null;
  readonly fileId: Id<"mediaFiles"> | null;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly watched: boolean;
  readonly playedAt: number;
  /** The playback reporting, or null for a mark or an offline report. */
  readonly origin: PlayOrigin | null;
}

/** Whether a write applied, and whether the item counts as watched after it. */
export interface ProgressReceipt {
  readonly applied: boolean;
  readonly watched: boolean;
}

/**
 * Writes a person's progress through one item. A report from a start older than the one on
 * another session that last reported is stale and ignored, so an old tab cannot drag a newer
 * device's position back. Watched stays set until the person marks the item unwatched.
 */
export const writeProgress = async (
  ctx: Pick<MutationCtx, "db">,
  write: ProgressWrite,
): Promise<ProgressReceipt> => {
  const existing = await findProgress(ctx.db, write.userId, write.titleId, write.episodeId);
  const { origin } = write;

  const stale =
    origin !== null &&
    existing?.playSessionId !== undefined &&
    existing.playSessionId !== origin.sessionId &&
    (existing.playStartedAt ?? 0) > origin.startedAt;

  if (stale) return { applied: false, watched: existing.watched };

  const watched = write.watched || existing?.watched === true;

  const fields = {
    fileId: write.fileId ?? existing?.fileId ?? null,
    positionMs: write.positionMs,
    durationMs: write.durationMs,
    watched,
    updatedAt: Date.now(),
    lastPlayedAt: write.playedAt,
  };

  const owned =
    origin === null
      ? fields
      : { ...fields, playSessionId: origin.sessionId, playStartedAt: origin.startedAt };

  if (existing === null) {
    await ctx.db.insert("watchProgress", {
      userId: write.userId,
      titleId: write.titleId,
      episodeId: write.episodeId,
      ...owned,
    });
  } else {
    await ctx.db.patch(existing._id, owned);
  }

  return { applied: true, watched };
};

/** The episode after `episode` in season and episode order, specials (season 0) last. */
export const nextEpisodeAfter = async (
  db: DatabaseReader,
  episode: Doc<"episodes">,
): Promise<Doc<"episodes"> | null> => {
  const sameSeason = await db
    .query("episodes")
    .withIndex("by_title_order", (q) =>
      q
        .eq("titleId", episode.titleId)
        .eq("seasonNumber", episode.seasonNumber)
        .gt("episodeNumber", episode.episodeNumber),
    )
    .first();

  if (sameSeason !== null || episode.seasonNumber === 0) return sameSeason;

  return db
    .query("episodes")
    .withIndex("by_title_order", (q) =>
      q.eq("titleId", episode.titleId).gt("seasonNumber", episode.seasonNumber),
    )
    .first();
};

const firstEpisode = async (
  db: DatabaseReader,
  titleId: Id<"titles">,
): Promise<Doc<"episodes"> | null> => {
  const regular = await db
    .query("episodes")
    .withIndex("by_title_order", (q) => q.eq("titleId", titleId).gte("seasonNumber", 1))
    .first();

  return (
    regular ??
    db
      .query("episodes")
      .withIndex("by_title_order", (q) => q.eq("titleId", titleId))
      .first()
  );
};

const MAX_SKIPPED_EPISODES = 100;

const followingEpisodes = async (
  db: DatabaseReader,
  episode: Doc<"episodes">,
  count: number,
): Promise<ReadonlyArray<Doc<"episodes">>> => {
  const sameSeason = await db
    .query("episodes")
    .withIndex("by_title_order", (q) =>
      q
        .eq("titleId", episode.titleId)
        .eq("seasonNumber", episode.seasonNumber)
        .gt("episodeNumber", episode.episodeNumber),
    )
    .take(count);

  if (sameSeason.length >= count || episode.seasonNumber === 0) return sameSeason;

  const later = await db
    .query("episodes")
    .withIndex("by_title_order", (q) =>
      q.eq("titleId", episode.titleId).gt("seasonNumber", episode.seasonNumber),
    )
    .take(count - sameSeason.length);

  return [...sameSeason, ...later];
};

interface Unwatched {
  readonly episode: Doc<"episodes"> | null;
  readonly examined: number;
}

const firstUnwatched = async (
  db: DatabaseReader,
  userId: Id<"users">,
  episodes: ReadonlyArray<Doc<"episodes">>,
  index: number,
): Promise<Unwatched> => {
  const next = episodes[index];

  if (next === undefined) return { episode: null, examined: index };

  const progress = await findProgress(db, userId, next.titleId, next._id);

  return progress?.watched === true
    ? firstUnwatched(db, userId, episodes, index + 1)
    : { episode: next, examined: index + 1 };
};

const SCAN_BATCH = 10;

interface Scanned {
  readonly episode: Doc<"episodes"> | null;
  readonly reads: number;
}

const scanUnwatched = async (
  db: DatabaseReader,
  userId: Id<"users">,
  episode: Doc<"episodes">,
  maxSkipped: number,
  giveUp: boolean,
): Promise<Scanned> => {
  const step = async (after: Doc<"episodes">, skipped: number, reads: number): Promise<Scanned> => {
    const left = maxSkipped - skipped;
    const wanted = left <= SCAN_BATCH ? left + 1 : SCAN_BATCH;
    const batch = await followingEpisodes(db, after, wanted);
    const found = await firstUnwatched(db, userId, batch.slice(0, left), 0);
    const spent = reads + batch.length + found.examined;

    if (found.episode !== null) return { episode: found.episode, reads: spent };

    if (batch.length < wanted) return { episode: null, reads: spent };

    if (found.examined >= left) {
      return { episode: giveUp ? (batch[left] ?? null) : null, reads: spent };
    }

    const last = batch.at(-1);

    return last === undefined
      ? { episode: null, reads: spent }
      : step(last, skipped + found.examined, spent);
  };

  return step(episode, 0, 0);
};

const SHOW_PROGRESS_MAX = 1000;

const latestShowProgress = async (
  db: DatabaseReader,
  userId: Id<"users">,
  titleId: Id<"titles">,
): Promise<Doc<"watchProgress"> | null> => {
  const rows = await db
    .query("watchProgress")
    .withIndex("by_user_item", (q) => q.eq("userId", userId).eq("titleId", titleId))
    .take(SHOW_PROGRESS_MAX);

  return rows.reduce<Doc<"watchProgress"> | null>(
    (latest, row) =>
      row.episodeId !== null && (latest === null || row.lastPlayedAt > latest.lastPlayedAt)
        ? row
        : latest,
    null,
  );
};

/**
 * The episode a show's Play button starts: the one in progress, the one after the last finished
 * one, or the first. Null when the show is finished or has no episodes.
 */
export const upNextEpisode = async (
  db: DatabaseReader,
  userId: Id<"users">,
  titleId: Id<"titles">,
): Promise<Doc<"episodes"> | null> => {
  const latest = await latestShowProgress(db, userId, titleId);

  if (latest?.episodeId === null || latest === null) return firstEpisode(db, titleId);

  const episode = await db.get(latest.episodeId);

  if (episode === null) return firstEpisode(db, titleId);

  return isFinished(latest)
    ? (await scanUnwatched(db, userId, episode, MAX_SKIPPED_EPISODES, true)).episode
    : episode;
};

const CONTINUE_LIMIT = 20;

const CONTINUE_SCAN = 200;

/**
 * Documents (episodes and their progress rows) continue watching may read in all while finding
 * next episodes, so a person with many finished shows cannot push one query past Convex's limits.
 */
const NEXT_EPISODE_BUDGET = 500;

type Candidate =
  | { readonly kind: "skip" }
  | { readonly kind: "item"; readonly item: ContinueItem }
  | { readonly kind: "next"; readonly title: Doc<"titles">; readonly episode: Doc<"episodes"> };

const SKIP: Candidate = { kind: "skip" };

const candidateOf = async (
  db: DatabaseReader,
  sees: TitleViewer,
  row: Doc<"watchProgress">,
): Promise<Candidate> => {
  const title = await db.get(row.titleId);

  if (title === null || !(await sees(title))) return SKIP;

  const finished = isFinished(row);

  if (row.episodeId === null) {
    return finished || row.positionMs <= 0
      ? SKIP
      : {
          kind: "item",
          item: {
            reason: "resume",
            title: presentTitleCard(title),
            episode: null,
            progress: presentProgress(row),
          },
        };
  }

  const episode = await db.get(row.episodeId);

  if (episode === null) return SKIP;

  if (!finished && row.positionMs > 0) {
    return {
      kind: "item",
      item: {
        reason: "resume",
        title: presentTitleCard(title),
        episode: presentEpisode(episode, row),
        progress: presentProgress(row),
      },
    };
  }

  return { kind: "next", title, episode };
};

const READS_PER_SKIPPED_EPISODE = 2;

const NEXT_ITEM_LOOKAHEAD_READS = 1;

const NEXT_ITEM_PROGRESS_READS = 1;

interface NextItem {
  readonly item: ContinueItem | null;
  readonly reads: number;
}

const nextItemOf = async (
  db: DatabaseReader,
  userId: Id<"users">,
  title: Doc<"titles">,
  episode: Doc<"episodes">,
  budget: number,
): Promise<NextItem> => {
  const maxSkipped = Math.min(
    MAX_SKIPPED_EPISODES,
    Math.floor(
      (budget - NEXT_ITEM_LOOKAHEAD_READS - NEXT_ITEM_PROGRESS_READS) / READS_PER_SKIPPED_EPISODE,
    ),
  );

  if (maxSkipped < 1) return { item: null, reads: 0 };

  const scanned = await scanUnwatched(
    db,
    userId,
    episode,
    maxSkipped,
    maxSkipped === MAX_SKIPPED_EPISODES,
  );

  const next = scanned.episode;

  if (next === null || next.presentFileCount === 0) return { item: null, reads: scanned.reads };

  return {
    item: {
      reason: "next",
      title: presentTitleCard(title),
      episode: await presentEpisodeFor(db, userId, next),
      progress: null,
    },
    reads: scanned.reads + NEXT_ITEM_PROGRESS_READS,
  };
};

interface Collected {
  readonly items: ReadonlyArray<ContinueItem>;
  readonly budget: number;
}

/**
 * Continue watching for a person, most recent first: movies and episodes in progress, and for
 * shows whose latest episode is finished, the next one. Each title appears once, and only titles
 * `sees` allows. Rows resolve a batch at a time, as many as the row still needs; next-episode
 * lookups then run in order and share one read budget.
 */
export const continueWatching = async (
  db: DatabaseReader,
  userId: Id<"users">,
  sees: TitleViewer,
): Promise<ReadonlyArray<ContinueItem>> => {
  const rows = await db
    .query("watchProgress")
    .withIndex("by_user_played", (q) => q.eq("userId", userId))
    .order("desc")
    .take(CONTINUE_SCAN);

  const seen = new Set<Id<"titles">>();

  const latestPerTitle = rows.filter((row) => {
    if (seen.has(row.titleId)) return false;

    seen.add(row.titleId);

    return true;
  });

  const collect = async (
    candidates: ReadonlyArray<Candidate>,
    index: number,
    collected: Collected,
  ): Promise<Collected> => {
    const candidate = candidates[index];
    const { items, budget } = collected;

    if (candidate === undefined || items.length >= CONTINUE_LIMIT) return collected;

    if (candidate.kind === "skip") return collect(candidates, index + 1, collected);

    if (candidate.kind === "item") {
      return collect(candidates, index + 1, { items: [...items, candidate.item], budget });
    }

    const next = await nextItemOf(db, userId, candidate.title, candidate.episode, budget);

    return collect(candidates, index + 1, {
      items: next.item === null ? items : [...items, next.item],
      budget: budget - next.reads,
    });
  };

  const fromBatch = async (
    start: number,
    collected: Collected,
  ): Promise<ReadonlyArray<ContinueItem>> => {
    const batch = latestPerTitle.slice(start, start + CONTINUE_LIMIT - collected.items.length);

    if (batch.length === 0) return collected.items;

    const candidates = await Promise.all(batch.map(async (row) => candidateOf(db, sees, row)));

    return fromBatch(start + batch.length, await collect(candidates, 0, collected));
  };

  return fromBatch(0, { items: [], budget: NEXT_EPISODE_BUDGET });
};
