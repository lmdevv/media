/** The part of the Web Locks API (`navigator.locks`) that {@link followLead} uses. */
export interface TabLocks {
  readonly request: (
    name: string,
    options: { readonly signal?: AbortSignal; readonly steal?: boolean },
    callback: () => Promise<void>,
  ) => Promise<void>;
}

/** A tab's place in the election {@link followLead} runs. */
export interface TabLead {
  /** Takes the lead now, from whichever tab holds it; resolves once this tab leads, or stopped. */
  readonly take: () => Promise<void>;
  /** Leaves the election and lets go of the lead. */
  readonly stop: () => void;
}

/**
 * Elects one tab of this browser to speak for the browser's device, which every tab on the origin
 * shares (ADR 0020): two tabs reporting for one device would each undo the other's report. The
 * first tab to ask leads; a tab that starts playing takes the lead with `take`, and a tab that loses
 * it waits to lead again. Without Web Locks every tab leads, as before.
 *
 * @param onChange - Called with `true` when this tab starts leading and `false` when it stops.
 */
export const followLead = (
  locks: TabLocks | undefined,
  name: string,
  onChange: (leading: boolean) => void,
): TabLead => {
  if (locks === undefined) {
    onChange(true);

    return { take: async () => undefined, stop: () => undefined };
  }

  let leading = false;
  let stopped = false;
  let waiting: AbortController | null = null;
  let release: (() => void) | null = null;
  let waiters: Array<() => void> = [];

  const settleWaiters = (): void => {
    const settled = waiters;

    waiters = [];

    for (const resolve of settled) resolve();
  };

  const lead = (next: boolean): void => {
    if (next) settleWaiters();

    if (next === leading) return;
    leading = next;
    onChange(next);
  };

  const ask = (steal: boolean): void => {
    waiting?.abort();
    const asking = steal ? null : new AbortController();
    let held: (() => void) | null = null;

    waiting = asking;

    locks
      .request(name, asking === null ? { steal: true } : { signal: asking.signal }, async () => {
        if (waiting === asking) waiting = null;

        await new Promise<void>((resolve) => {
          held = resolve;
          release = resolve;
          lead(true);
        });
      })
      .catch(() => {
        // Aborted while waiting, which needs nothing, or the lead was taken from this tab.
        if (held === null || release !== held) return;
        release = null;
        lead(false);

        if (!stopped) ask(false);
      });
  };

  ask(false);

  return {
    take: async () => {
      if (leading || stopped) return;

      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        ask(true);
      });
    },
    stop: () => {
      stopped = true;
      waiting?.abort();
      waiting = null;
      const held = release;

      release = null;
      held?.();
      lead(false);
      settleWaiters();
    },
  };
};
