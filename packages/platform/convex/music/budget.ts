import { CALL_BUDGET, addWork, work } from "../movies/budget";
import type { Work } from "../movies/budget";

/**
 * What one step of a music mutation may cost at worst: movies' index ranges and writes (ADR
 * 0024), and the bytes it reads and writes. Movies bounds its bytes by its batch sizes, since its
 * documents have small bounds. A track's lyrics row may be 512 KiB, so 500 of them would pass
 * Convex's 16 MiB a call: music charges bytes too.
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

/** A step that costs nothing. */
export const NO_COST: Cost = cost(0, 0);

export const addCost = (left: Cost, right: Cost): Cost => ({
  work: addWork(left.work, right.work),
  readBytes: left.readBytes + right.readBytes,
  writeBytes: left.writeBytes + right.writeBytes,
});

/** The bytes a call reads, and writes, at most: 12 MiB each, under Convex's 16 MiB. */
const CALL_BYTES = 12 * 1024 * 1024;

/** How much one call spends at most: movies' ranges and writes, and 12 MiB each way. */
export const CALL_COST: Cost = { work: CALL_BUDGET, readBytes: CALL_BYTES, writeBytes: CALL_BYTES };

/**
 * A call's budget, as movies' `Budget`: each step is charged its worst case before it runs, a step
 * that would go past the budget does not start, and the first step always runs.
 */
export interface Budget {
  readonly admits: (step: Cost) => boolean;
  readonly spend: (step: Cost) => void;
}

const within = (spent: Cost, limit: Cost): boolean =>
  spent.work.ranges <= limit.work.ranges &&
  spent.work.writes <= limit.work.writes &&
  spent.readBytes <= limit.readBytes &&
  spent.writeBytes <= limit.writeBytes;

/** A budget for one call of `limit` (the call's unless a test passes a smaller one), less `fixed`. */
export const budgetFor = (fixed: Cost, limit: Cost = CALL_COST): Budget => {
  let spent = fixed;
  let steps = 0;

  return {
    admits: (step) => steps === 0 || within(addCost(spent, step), limit),
    spend: (step) => {
      spent = addCost(spent, step);
      steps += 1;
    },
  };
};

/** One item's work: its worst case, priced from what it read to plan it, and the work itself. */
export interface Step<Result> {
  readonly cost: Cost;
  readonly run: () => Promise<Result>;
}

/**
 * Plans the leading items one after the other and runs each whose worst case the budget admits,
 * stopping at the first it does not. Each plan reads what it prices from after the item before it
 * ran, so a plan sees that item's writes. Answers the results of the items that ran.
 */
export const whileBudget = async <Item, Result>(
  budget: Budget,
  items: ReadonlyArray<Item>,
  plan: (item: Item) => Promise<Step<Result>>,
  done: ReadonlyArray<Result> = [],
): Promise<ReadonlyArray<Result>> => {
  const [first, ...rest] = items;

  if (first === undefined) return done;

  const step = await plan(first);

  if (!budget.admits(step.cost)) return done;

  budget.spend(step.cost);

  const result = await step.run();

  return whileBudget(budget, rest, plan, [...done, result]);
};
