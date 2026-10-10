/**
 * Runs `step` for each item, one at a time, in order. Convex mutations use this for writes that
 * read what the previous write changed, such as album and library counters; running them
 * concurrently would lose updates.
 */
export const inOrder = async <Item>(
  items: ReadonlyArray<Item>,
  step: (item: Item, index: number) => Promise<void>,
): Promise<void> => {
  const run = async (index: number): Promise<void> => {
    if (index >= items.length) return;
    const item = items[index];

    if (item !== undefined) await step(item, index);
    await run(index + 1);
  };

  await run(0);
};
