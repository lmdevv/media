import { LIST_CALL_READS } from "../core/permissions/grants";
import type { Reach } from "../core/permissions/grants";

/** What reads cost against Convex's per-call limits: index ranges, documents, and bytes. */
export interface Reads {
  readonly ranges: number;
  readonly documents: number;
  readonly bytes: number;
}

/**
 * What a row the movies reads count as, in bytes, at most in practice: a grant, a library, a list
 * entry, or a progress row is small; a title carries its overview, tags, and recommendations.
 */
const SMALL_BYTES = 512;

const TITLE_BYTES = 6 * 1024;

const EPISODE_BYTES = 2 * 1024;

const PERSON_BYTES = 2 * 1024;

const COLLECTION_BYTES = 2 * 1024;

/** Reads of `documents` small rows, as most of the movies reads are. */
export const readsOf = (
  ranges: number,
  documents: number,
  bytes = documents * SMALL_BYTES,
): Reads => ({ ranges, documents, bytes });

/** Two costs paid one after the other. */
export const plus = (left: Reads, right: Reads): Reads =>
  readsOf(left.ranges + right.ranges, left.documents + right.documents, left.bytes + right.bytes);

/** `cost` paid `count` times. */
export const times = (cost: Reads, count: number): Reads =>
  readsOf(cost.ranges * count, cost.documents * count, cost.bytes * count);

/**
 * What one call's reads may cost at most. Convex fails a call past 4,096 index ranges, 32,000
 * documents, or 16 MiB read (ADR 0013), counting a range for every `get` and every query; this
 * leaves 1,096 ranges, 2,000 documents, and 4 MiB for the call's fixed work and for an estimate
 * that undercounts.
 */
export const CALL_READS: Reads = readsOf(3_000, 30_000, 12 * 1024 * 1024);

/** One `db.get` of a small row: a range, and at most one document. */
export const GET: Reads = readsOf(1, 1);

/** One indexed query that returns at most `documents` small rows. */
export const queryOf = (documents: number): Reads => readsOf(1, documents);

/** One `db.get` of a title. */
export const TITLE_GET: Reads = readsOf(1, 1, TITLE_BYTES);

/** One `db.get` of an episode. */
export const EPISODE_GET: Reads = readsOf(1, 1, EPISODE_BYTES);

/** Indexed queries, `ranges` of them, that return at most `count` titles in all. */
export const titlesOf = (count: number, ranges = 1): Reads =>
  readsOf(ranges, count, count * TITLE_BYTES);

/** Indexed queries, `ranges` of them, that return at most `count` episodes in all. */
export const episodesOf = (count: number, ranges = 1): Reads =>
  readsOf(ranges, count, count * EPISODE_BYTES);

/** One search that returns at most `count` people. */
export const peopleOf = (count: number): Reads => readsOf(1, count, count * PERSON_BYTES);

/** One indexed query that returns at most `count` collections. */
export const collectionsOf = (count: number): Reads => readsOf(1, count, count * COLLECTION_BYTES);

/**
 * What deciding one library for the principal of `reach` reads the first time: the library, and
 * one grant query per grant key (their own, the household's, and each group's), as `levelOn` does.
 */
export const libraryCheck = (reach: Reach): Reads => {
  const keys = reach.direct.length + reach.groups.length;

  return readsOf(1 + keys, 1 + keys);
};

/**
 * What every access-checked call reads before its own rows: the caller and their session, and the
 * principal's reach (their group memberships), as `decidableRows` charges them.
 */
export const callReads = (reach: Reach): Reads =>
  readsOf(LIST_CALL_READS + 1, LIST_CALL_READS + reach.groups.length);

/** A share of one call's reads, charged against the call's total as well as its own cap. */
export interface ReadBudget {
  /** Charges `cost` when it fits both this budget and every budget it is part of. */
  readonly take: (cost: Reads) => boolean;
  /** What is left to spend, as the tightest of this budget and the ones it is part of. */
  readonly left: () => Reads;
  /** A part of this budget: at most `share` (0 to 1) of what is left of it now. */
  readonly part: (share: number) => ReadBudget;
}

const fits = (cost: Reads, room: Reads): boolean =>
  cost.ranges <= room.ranges && cost.documents <= room.documents && cost.bytes <= room.bytes;

const budgetWith = (cap: Reads, parent: ReadBudget | null): ReadBudget => {
  let spent = readsOf(0, 0, 0);

  const left = (): Reads => {
    const mine = readsOf(
      cap.ranges - spent.ranges,
      cap.documents - spent.documents,
      cap.bytes - spent.bytes,
    );

    const above = parent?.left() ?? mine;

    return readsOf(
      Math.min(mine.ranges, above.ranges),
      Math.min(mine.documents, above.documents),
      Math.min(mine.bytes, above.bytes),
    );
  };

  const budget: ReadBudget = {
    take: (cost) => {
      if (!fits(cost, left()) || (parent !== null && !parent.take(cost))) return false;

      spent = plus(spent, cost);

      return true;
    },
    left,
    part: (share) => {
      const room = left();

      return budgetWith(
        readsOf(
          Math.floor(room.ranges * share),
          Math.floor(room.documents * share),
          Math.floor(room.bytes * share),
        ),
        budget,
      );
    },
  };

  return budget;
};

/** One call's read budget, with what `reach`'s call reads before its rows already charged. */
export const callBudget = (reach: Reach): ReadBudget => {
  const fixed = callReads(reach);

  return budgetWith(
    readsOf(
      CALL_READS.ranges - fixed.ranges,
      CALL_READS.documents - fixed.documents,
      CALL_READS.bytes - fixed.bytes,
    ),
    null,
  );
};
