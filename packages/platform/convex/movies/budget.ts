/**
 * What one step of a mutation may cost at worst: the index ranges it reads and the documents it
 * writes. Convex counts a range for every `get`, query, patch, replace, and delete, and fails a
 * call past 4,096 ranges or 16,000 writes (ADR 0013), rolling back everything it did.
 */
export interface Work {
  readonly ranges: number;
  readonly writes: number;
}

export const work = (ranges: number, writes: number): Work => ({ ranges, writes });

/** A step that costs nothing. */
export const NO_WORK: Work = work(0, 0);

export const addWork = (left: Work, right: Work): Work =>
  work(left.ranges + right.ranges, left.writes + right.writes);

/**
 * How much one call spends at most, with headroom under Convex's limits for the call's own fixed
 * work (the lease check, the counters) and for an estimate that undercounts a step.
 */
export const CALL_BUDGET: Work = work(3_200, 12_000);

/**
 * A call's work budget. Each step is charged its worst case before it runs. A step that would go
 * past the budget does not start, so the call commits every step it did and reports how far it
 * got; the caller sends the rest again. The first step always runs, and every step's worst case
 * is far below the budget, so each call makes progress.
 */
export interface Budget {
  /** Whether a step of `cost` may still run: always for the call's first step. */
  readonly admits: (cost: Work) => boolean;
  /** Charges a step that runs. */
  readonly spend: (cost: Work) => void;
}

/**
 * A budget for one call of `limit` (the call budget unless a test passes a smaller one), less what
 * the call's own fixed work costs.
 */
export const budgetFor = (fixed: Work, limit: Work = CALL_BUDGET): Budget => {
  let spent = fixed;
  let steps = 0;

  return {
    admits: (cost) =>
      steps === 0 ||
      (spent.ranges + cost.ranges <= limit.ranges && spent.writes + cost.writes <= limit.writes),
    spend: (cost) => {
      spent = addWork(spent, cost);
      steps += 1;
    },
  };
};

/**
 * Runs `run` on the leading items whose worst case, from `cost`, the budget admits, one after the
 * other, and stops at the first it does not. Answers the results of the items that ran.
 */
export const whileBudget = async <Item, Result>(
  budget: Budget,
  items: ReadonlyArray<Item>,
  cost: (item: Item) => Promise<Work> | Work,
  run: (item: Item) => Promise<Result>,
  done: ReadonlyArray<Result> = [],
): Promise<ReadonlyArray<Result>> => {
  const [first, ...rest] = items;

  if (first === undefined) return done;

  const charge = await cost(first);

  if (!budget.admits(charge)) return done;

  budget.spend(charge);

  const result = await run(first);

  return whileBudget(budget, rest, cost, run, [...done, result]);
};
