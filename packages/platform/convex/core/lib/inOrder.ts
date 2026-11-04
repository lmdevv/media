/**
 * Runs `run` on each item after the previous call settled, and returns the results in order. Use
 * it where calls in one mutation read and then write the same row, which `Promise.all` would let
 * interleave so that one write overwrites another.
 */
export const inOrder = async <Item, Result>(
  items: ReadonlyArray<Item>,
  run: (item: Item) => Promise<Result>,
): Promise<ReadonlyArray<Result>> => {
  const results: Array<Result> = [];

  await items.reduce<Promise<void>>(async (previous, item) => {
    await previous;
    results.push(await run(item));
  }, Promise.resolve());

  return results;
};
