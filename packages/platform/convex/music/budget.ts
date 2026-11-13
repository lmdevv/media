import { CALL_BUDGET, addWork, work } from "../movies/budget";
import type { Work } from "../movies/budget";

/**
 * What music database work costs: movies' index ranges and writes (ADR 0024), and the bytes read
 * and written. Movies bounds its bytes by its batch sizes, since its documents have small bounds.
 * A track's lyrics row may be 512 KiB, so 500 of them would pass Convex's 16 MiB a call: music
 * counts bytes too. It also counts the bytes of lyric sets a call's code walks, which bound its
 * time: a row may pack thousands of small sets, lines, or words, each of them walked to check,
 * measure, hash, and compare, so a call could spend Convex's 1 s well inside its database bytes.
 */
export interface Cost {
  readonly work: Work;
  readonly readBytes: number;
  readonly writeBytes: number;
  readonly lyricBytes: number;
}

export const cost = (ranges: number, writes: number, readBytes = 0, writeBytes = 0): Cost => ({
  work: work(ranges, writes),
  readBytes,
  writeBytes,
  lyricBytes: 0,
});

/** Walking lyric sets of `bytes`, in Convex's measure, as the music store reads or writes them. */
export const lyricsCost = (bytes: number): Cost => ({ ...cost(0, 0), lyricBytes: bytes });

export const NO_COST: Cost = cost(0, 0);

export const addCost = (left: Cost, right: Cost): Cost => ({
  work: addWork(left.work, right.work),
  readBytes: left.readBytes + right.readBytes,
  writeBytes: left.writeBytes + right.writeBytes,
  lyricBytes: left.lyricBytes + right.lyricBytes,
});

export const sumCost = (costs: ReadonlyArray<Cost>): Cost => costs.reduce(addCost, NO_COST);

/** The bytes a call reads, and writes, at most: 12 MiB each, under Convex's 16 MiB. */
const CALL_BYTES = 12 * 1024 * 1024;

/**
 * The bytes of lyric sets a call walks at most: rewriting rows of the densest sets, about 80 bytes
 * each, takes about 60 ms a MiB on the dev stack, so a call spends about a quarter of Convex's 1 s
 * on its lyrics (ADR 0024).
 */
const CALL_LYRIC_BYTES = 4 * 1024 * 1024;

/** How much one call spends at most: movies' ranges and writes, 12 MiB each way, and its lyrics. */
export const CALL_COST: Cost = {
  work: CALL_BUDGET,
  readBytes: CALL_BYTES,
  writeBytes: CALL_BYTES,
  lyricBytes: CALL_LYRIC_BYTES,
};

const within = (spent: Cost, limit: Cost): boolean =>
  spent.work.ranges <= limit.work.ranges &&
  spent.work.writes <= limit.work.writes &&
  spent.readBytes <= limit.readBytes &&
  spent.writeBytes <= limit.writeBytes &&
  spent.lyricBytes <= limit.lyricBytes;

/**
 * What one music mutation has spent. The music store (`write.ts`) charges it for each read and
 * write as it makes them; a call charges up front its work outside the store, and work it will
 * owe at its end. That owed work is charged again as it runs, so after the call's last item the
 * meter overstates; nothing reads it then.
 */
export interface Meter {
  readonly charge: (spent: Cost) => void;
  readonly spent: () => Cost;
}

/** A meter that starts at `fixed`: the call's work outside the music store. */
export const meterFrom = (fixed: Cost): Meter => {
  let spent = fixed;

  return {
    charge: (more) => {
      spent = addCost(spent, more);
    },
    spent: () => spent,
  };
};

/**
 * Runs `write` on the leading items one after the other, starting each after the first only while
 * what `meter` holds and `most`, the worst case of one item with what it owes at the call's end,
 * stay within `limit`. Answers the results of the items that ran, and the caller sends the rest
 * again (ADR 0024). Each item is charged what it really cost, so an item that cost less than
 * `most` leaves the rest for the next.
 */
export const whileBudget = async <Item, Result>(
  meter: Meter,
  limit: Cost,
  most: Cost,
  items: ReadonlyArray<Item>,
  write: (item: Item) => Promise<Result>,
  done: ReadonlyArray<Result> = [],
): Promise<ReadonlyArray<Result>> => {
  const [first, ...rest] = items;

  if (first === undefined) return done;

  if (done.length > 0 && !within(addCost(meter.spent(), most), limit)) return done;

  const result = await write(first);

  return whileBudget(meter, limit, most, rest, write, [...done, result]);
};
