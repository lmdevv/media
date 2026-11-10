import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import type { BudgetedViewer } from "./access";
import { presentEpisode, presentProgress, presentTitleCard } from "./present";
import type { ContinueItem, Episode } from "./present";
import { EPISODE_GET, TITLE_GET, episodesOf, queryOf, settleRead } from "./reads";
import { insertProgress, insertWatchMark, patchProgress, patchWatchMark } from "./write";
import type { ReadBudget, Reads } from "./reads";

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

/**
 * The playback a report comes from: the id `movies.play.start` gave that one start, and when it
 * ran. Each start is its own playback, as each of old movies' playback sessions was, so two tabs
 * of one sign-in or a title opened again are two playbacks.
 */
export interface PlayOrigin {
  readonly playId: string;
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
 * Writes a person's progress through one item. A report from another playback that started before
 * the one that last reported is stale and ignored, even on the same sign-in, so an old tab or an
 * earlier start cannot drag a newer one's position back. Watched stays set until the person marks
 * the item unwatched.
 */
export const writeProgress = async (
  ctx: Pick<MutationCtx, "db">,
  write: ProgressWrite,
): Promise<ProgressReceipt> => {
  const existing = await findProgress(ctx.db, write.userId, write.titleId, write.episodeId);
  const { origin } = write;

  const stale =
    origin !== null &&
    existing?.playId !== undefined &&
    existing.playId !== origin.playId &&
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
      : { ...fields, playId: origin.playId, playStartedAt: origin.startedAt };

  if (existing === null) {
    await insertProgress(ctx.db, {
      userId: write.userId,
      titleId: write.titleId,
      episodeId: write.episodeId,
      ...owned,
    });
  } else {
    await patchProgress(ctx.db, existing._id, owned);
  }

  return { applied: true, watched };
};

const watchMarkOf = (db: DatabaseReader, userId: Id<"users">, titleId: Id<"titles">) =>
  db
    .query("watchMarks")
    .withIndex("by_user_title", (q) => q.eq("userId", userId).eq("titleId", titleId))
    .unique();

/** The generation of a person's history of one title: 0 until it first changes. */
export const watchGeneration = async (
  db: DatabaseReader,
  userId: Id<"users">,
  titleId: Id<"titles">,
): Promise<number> => (await watchMarkOf(db, userId, titleId))?.generation ?? 0;

/**
 * Moves the generation of a person's history of one title, for every mark and progress report,
 * and answers the new one. A scheduled page of an older change then writes nothing. A mark of the
 * whole title passes `markedAt`, its time, which an import defers to.
 */
export const nextWatchGeneration = async (
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  titleId: Id<"titles">,
  markedAt?: number,
): Promise<number> => {
  const mark = await watchMarkOf(ctx.db, userId, titleId);
  const generation = (mark?.generation ?? 0) + 1;
  const marked = markedAt === undefined ? {} : { markedAt };

  if (mark === null) await insertWatchMark(ctx.db, { userId, titleId, generation, ...marked });
  else await patchWatchMark(ctx.db, mark._id, { generation, ...marked });

  return generation;
};

/** When the person last marked the whole title, or null when they never did. */
export const wholeTitleMarkedAt = async (
  db: DatabaseReader,
  userId: Id<"users">,
  titleId: Id<"titles">,
): Promise<number | null> => (await watchMarkOf(db, userId, titleId))?.markedAt ?? null;

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

/** Charges a read to a budget, or always allows it when the reads are bounded otherwise. */
type Charge = (cost: Reads) => boolean;

const UNBOUNDED: Charge = () => true;

/** Settles a charged read on the documents it returned. */
type Settle = (reserved: Reads, read: ReadonlyArray<Doc<"episodes">>) => void;

const NO_SETTLE: Settle = () => undefined;

interface Unwatched {
  readonly episode: Doc<"episodes"> | null;
  readonly examined: number;
  /** The budget could not pay for every lookup the scan needed. */
  readonly spent: boolean;
}

const firstUnwatched = async (
  db: DatabaseReader,
  userId: Id<"users">,
  episodes: ReadonlyArray<Doc<"episodes">>,
  index: number,
  charge: Charge,
): Promise<Unwatched> => {
  const next = episodes[index];

  if (next === undefined) return { episode: null, examined: index, spent: false };

  if (!charge(queryOf(1))) return { episode: null, examined: index, spent: true };

  const progress = await findProgress(db, userId, next.titleId, next._id);

  return progress?.watched === true
    ? firstUnwatched(db, userId, episodes, index + 1, charge)
    : { episode: next, examined: index + 1, spent: false };
};

const SCAN_BATCH = 10;

/**
 * The first episode after `episode` the person has not watched, past at most `maxSkipped`
 * watched ones; with `giveUp`, the one after those when all of them were watched. Each episode
 * query and progress lookup is charged first, empty ones included, and a scan the charge refuses
 * finds nothing.
 */
const scanUnwatched = async (
  db: DatabaseReader,
  userId: Id<"users">,
  episode: Doc<"episodes">,
  maxSkipped: number,
  giveUp: boolean,
  charge: Charge,
  settle: Settle = NO_SETTLE,
): Promise<Doc<"episodes"> | null> => {
  const step = async (after: Doc<"episodes">, skipped: number): Promise<Doc<"episodes"> | null> => {
    const left = maxSkipped - skipped;
    const wanted = left <= SCAN_BATCH ? left + 1 : SCAN_BATCH;

    const reserved = episodesOf(wanted, 2);

    if (!charge(reserved)) return null;

    const batch = await followingEpisodes(db, after, wanted);

    settle(reserved, batch);
    const found = await firstUnwatched(db, userId, batch.slice(0, left), 0, charge);

    if (found.episode !== null || found.spent) return found.episode;

    if (batch.length < wanted) return null;

    if (found.examined >= left) return giveUp ? (batch[left] ?? null) : null;

    const last = batch.at(-1);

    return last === undefined ? null : step(last, skipped + found.examined);
  };

  return step(episode, 0);
};

const latestShowProgress = async (
  db: DatabaseReader,
  userId: Id<"users">,
  titleId: Id<"titles">,
): Promise<Doc<"watchProgress"> | null> => {
  const latest = await db
    .query("watchProgress")
    .withIndex("by_user_title_played", (q) => q.eq("userId", userId).eq("titleId", titleId))
    .order("desc")
    .first();

  return latest?.episodeId === null ? null : latest;
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
    ? scanUnwatched(db, userId, episode, MAX_SKIPPED_EPISODES, true, UNBOUNDED)
    : episode;
};

const CONTINUE_LIMIT = 20;

const CONTINUE_SCAN = 200;

type Candidate =
  | { readonly kind: "skip" }
  | { readonly kind: "item"; readonly item: ContinueItem }
  | { readonly kind: "next"; readonly title: Doc<"titles">; readonly episode: Doc<"episodes"> };

const SKIP: Candidate = { kind: "skip" };

const candidateOf = async (
  db: DatabaseReader,
  seen: BudgetedViewer,
  budget: ReadBudget,
  row: Doc<"watchProgress">,
): Promise<Candidate> => {
  if (!budget.take(TITLE_GET)) return SKIP;

  const title = await db.get(row.titleId);

  settleRead(budget, TITLE_GET, [title]);

  if (title === null || (await seen(title)) !== "seen") return SKIP;

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

  if (!budget.take(EPISODE_GET)) return SKIP;

  const episode = await db.get(row.episodeId);

  settleRead(budget, EPISODE_GET, [episode]);

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

const nextItemOf = async (
  db: DatabaseReader,
  userId: Id<"users">,
  title: Doc<"titles">,
  episode: Doc<"episodes">,
  budget: ReadBudget,
): Promise<ContinueItem | null> => {
  const next = await scanUnwatched(
    db,
    userId,
    episode,
    MAX_SKIPPED_EPISODES,
    true,
    budget.take,
    (reserved, read) => settleRead(budget, reserved, read),
  );

  if (next === null || next.presentFileCount === 0 || !budget.take(queryOf(1))) return null;

  return {
    reason: "next",
    title: presentTitleCard(title),
    episode: await presentEpisodeFor(db, userId, next),
    progress: null,
  };
};

/**
 * Continue watching for a person, most recent first: movies and episodes in progress, and for
 * shows whose latest episode is finished, the next one. Each title appears once, and only titles
 * `seen` allows. Every read is charged to `budget`, the empty next-episode lookups included;
 * when it runs out the row holds what it found by then, most recent first.
 */
export const continueWatching = async (
  db: DatabaseReader,
  userId: Id<"users">,
  seen: BudgetedViewer,
  budget: ReadBudget,
): Promise<ReadonlyArray<ContinueItem>> => {
  if (!budget.take(queryOf(CONTINUE_SCAN))) return [];

  const rows = await db
    .query("watchProgress")
    .withIndex("by_user_played", (q) => q.eq("userId", userId))
    .order("desc")
    .take(CONTINUE_SCAN);

  const titles = new Set<Id<"titles">>();

  const latestPerTitle = rows.filter((row) => {
    if (titles.has(row.titleId)) return false;

    titles.add(row.titleId);

    return true;
  });

  const collect = async (
    candidates: ReadonlyArray<Candidate>,
    index: number,
    items: ReadonlyArray<ContinueItem>,
  ): Promise<ReadonlyArray<ContinueItem>> => {
    const candidate = candidates[index];

    if (candidate === undefined || items.length >= CONTINUE_LIMIT) return items;

    if (candidate.kind === "skip") return collect(candidates, index + 1, items);

    if (candidate.kind === "item")
      return collect(candidates, index + 1, [...items, candidate.item]);

    const next = await nextItemOf(db, userId, candidate.title, candidate.episode, budget);

    return collect(candidates, index + 1, next === null ? items : [...items, next]);
  };

  const fromBatch = async (
    start: number,
    items: ReadonlyArray<ContinueItem>,
  ): Promise<ReadonlyArray<ContinueItem>> => {
    const batch = latestPerTitle.slice(start, start + CONTINUE_LIMIT - items.length);

    if (batch.length === 0) return items;

    const candidates = await Promise.all(
      batch.map(async (row) => candidateOf(db, seen, budget, row)),
    );

    return fromBatch(start + batch.length, await collect(candidates, 0, items));
  };

  return fromBatch(0, []);
};
