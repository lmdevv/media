import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { DOCUMENT_BYTES } from "./fit";
import { FILES_ON_DISK, filesOnDisk, presentProgress, presentVersion } from "./present";
import type { FeaturedDetail } from "./present";
import { plus, queryOf, readsOf } from "./reads";
import type { ReadBudget, Reads } from "./reads";
import { UP_NEXT_READS, findProgress, presentEpisodeFor, upNextEpisode } from "./viewing";

const SEASONS_MAX = 200;

/** What {@link playStateOf} reads of any title at most: its seasons and the person's list entry. */
const STATE_READS: Reads = plus(
  readsOf(1, SEASONS_MAX, SEASONS_MAX * DOCUMENT_BYTES.seasons),
  queryOf(1),
);

/**
 * What {@link featuredDetailOf} reads at most of a title of each kind: {@link playStateOf}'s
 * reads, and for a show the next episode's progress.
 */
export const FEATURED_READS: Readonly<Record<Doc<"titles">["kind"], Reads>> = {
  movie: plus(STATE_READS, plus(FILES_ON_DISK, queryOf(1))),
  show: plus(STATE_READS, plus(UP_NEXT_READS, queryOf(1))),
};

/** What a title's page and Home's billboard both read of a title for one person. */
interface PlayState {
  readonly seasons: ReadonlyArray<Doc<"seasons">>;
  /** A movie's files on disk, best first; a show's are on its episodes. */
  readonly files: ReadonlyArray<Doc<"mediaFiles">>;
  /** A movie's progress; a show's is on its episodes. */
  readonly progress: Doc<"watchProgress"> | null;
  /** The episode a show's Play button starts, null for a movie or a show with no episodes. */
  readonly next: Doc<"episodes"> | null;
  readonly inMyList: boolean;
}

/**
 * A title's seasons, a movie's files and progress or a show's next episode, and whether it is on
 * the person's list. `movies.titles.get` and Home's billboard both read them here, so the two
 * agree on what Play starts.
 */
export const playStateOf = async (
  db: DatabaseReader,
  userId: Id<"users">,
  title: Doc<"titles">,
): Promise<PlayState> => {
  const movie = title.kind === "movie";

  const [seasons, files, progress, next, listed] = await Promise.all([
    db
      .query("seasons")
      .withIndex("by_title_number", (q) => q.eq("titleId", title._id))
      .take(SEASONS_MAX),
    movie ? filesOnDisk(db, title, null) : [],
    movie ? findProgress(db, userId, title._id, null) : null,
    movie ? null : upNextEpisode(db, userId, title._id),
    db
      .query("myList")
      .withIndex("by_user_title", (q) => q.eq("userId", userId).eq("titleId", title._id))
      .unique(),
  ]);

  return { seasons, files, progress, next, inMyList: listed !== null };
};

/** A title's overview, an admin's over the scanned one. */
export const overviewOf = (title: Doc<"titles">): string | null =>
  title.overrides?.overview ?? title.overview;

/**
 * What Home's billboard shows of `title`, as `movies.titles.get` answers it, or undefined when
 * `budget` cannot pay for the most it may read. The caller has decided that the person sees
 * `title`; everything else read here is the person's own.
 */
export const featuredDetailOf = async (
  db: DatabaseReader,
  userId: Id<"users">,
  title: Doc<"titles">,
  budget: ReadBudget,
): Promise<FeaturedDetail | undefined> => {
  if (!budget.take(FEATURED_READS[title.kind])) return undefined;

  const state = await playStateOf(db, userId, title);
  const [file] = state.files;

  return {
    id: title._id,
    overview: overviewOf(title),
    seasonCount: state.seasons.length,
    version: file === undefined ? null : presentVersion(file, state.progress?.fileId ?? null),
    progress: state.progress === null ? null : presentProgress(state.progress),
    nextEpisode: state.next === null ? null : await presentEpisodeFor(db, userId, state.next),
    inMyList: state.inMyList,
  };
};
