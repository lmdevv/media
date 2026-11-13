import { CALL_BUDGET, addWork, work } from "../movies/budget";
import type { Work } from "../movies/budget";

/**
 * What music database work costs: movies' index ranges and writes (ADR 0024), and the bytes read
 * and written. Movies bounds its bytes by its batch sizes, since its documents have small bounds.
 * A track's lyrics row may be 512 KiB, so 500 of them would pass Convex's 16 MiB a call: music
 * counts bytes too.
 */
export interface Cost {
  readonly work: Work;
  readonly readBytes: number;
  readonly writeBytes: number;
}

export const cost = (ranges: number, writes: number, readBytes = 0, writeBytes = 0): Cost => ({
  work: work(ranges, writes),
  readBytes,
  writeBytes,
});

export const NO_COST: Cost = cost(0, 0);

export const addCost = (left: Cost, right: Cost): Cost => ({
  work: addWork(left.work, right.work),
  readBytes: left.readBytes + right.readBytes,
  writeBytes: left.writeBytes + right.writeBytes,
});

export const sumCost = (costs: ReadonlyArray<Cost>): Cost => costs.reduce(addCost, NO_COST);

/** The bytes a call reads, and writes, at most: 12 MiB each, under Convex's 16 MiB. */
const CALL_BYTES = 12 * 1024 * 1024;

/** How much one call spends at most: movies' ranges and writes, and 12 MiB each way. */
export const CALL_COST: Cost = { work: CALL_BUDGET, readBytes: CALL_BYTES, writeBytes: CALL_BYTES };

const within = (spent: Cost, limit: Cost): boolean =>
  spent.work.ranges <= limit.work.ranges &&
  spent.work.writes <= limit.work.writes &&
  spent.readBytes <= limit.readBytes &&
  spent.writeBytes <= limit.writeBytes;

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
