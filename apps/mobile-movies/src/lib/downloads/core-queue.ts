/**
 * Runs the core calls about one item one after another, in the order asked, so a remove sent while
 * an add is still in flight lands after it and the core is not left keeping a cancelled item. Calls
 * about different items run side by side. A call that fails does not hold up the next.
 */
export interface CoreQueue {
  readonly run: <A>(item: string, call: () => Promise<A>) => Promise<A>;
}

/** An empty queue. */
export const coreQueue = (): CoreQueue => {
  const tails = new Map<string, Promise<unknown>>();

  return {
    run: (item, call) => {
      const previous = tails.get(item) ?? Promise.resolve();
      const next = previous.then(call, call);

      const settled = next.then(
        () => undefined,
        () => undefined,
      );

      tails.set(item, settled);
      void settled.then(() => {
        if (tails.get(item) === settled) tails.delete(item);

        return undefined;
      });

      return next;
    },
  };
};
