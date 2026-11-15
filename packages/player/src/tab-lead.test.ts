import { describe, expect, it } from "vitest";

import { followLead } from "./tab-lead";
import type { TabLocks } from "./tab-lead";

interface Request {
  readonly callback: () => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: DOMException) => void;
}

const aborted = (): DOMException => new DOMException("The lock request was aborted", "AbortError");

/**
 * One exclusive lock as the Web Locks API keeps it: requests wait in order, a waiting request
 * leaves when its signal aborts, `steal` takes the lock from its holder, whose request then fails,
 * a holder lets go when its callback settles, and every grant runs its callback a task later.
 */
class MemoryLocks implements TabLocks {
  #holder: Request | null = null;
  readonly #waiting: Array<Request> = [];

  request = (
    _name: string,
    options: { readonly signal?: AbortSignal; readonly steal?: boolean },
    callback: () => Promise<void>,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const request = { callback, resolve, reject };

      if (options.steal === true) {
        const held = this.#holder;

        this.#holder = null;
        held?.reject(aborted());
        this.#grant(request);

        return;
      }

      if (this.#holder === null && this.#waiting.length === 0) {
        this.#grant(request);

        return;
      }

      this.#waiting.push(request);
      options.signal?.addEventListener("abort", () => {
        const at = this.#waiting.indexOf(request);

        if (at === -1) return;
        this.#waiting.splice(at, 1);
        reject(aborted());
      });
    });

  #grant(request: Request): void {
    this.#holder = request;
    setTimeout(() => {
      void this.#hold(request);
    }, 0);
  }

  async #hold(request: Request): Promise<void> {
    await request.callback();

    if (this.#holder !== request) return;
    this.#holder = null;
    request.resolve();
    const next = this.#waiting.shift();

    if (next !== undefined) this.#grant(next);
  }
}

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** Lets every pending grant and promise settle: a hand-over takes a few tasks. */
const flush = async (turns = 5): Promise<void> => {
  if (turns === 0) return;
  await tick();
  await flush(turns - 1);
};

const tab = (locks: TabLocks | undefined) => {
  const states: Array<boolean> = [];

  const lead = followLead(locks, "lead", (leading) => {
    states.push(leading);
  });

  return { lead, leading: () => states.at(-1) ?? false, states };
};

describe("followLead", () => {
  it("lets the first tab lead while the next one waits", async () => {
    const locks = new MemoryLocks();
    const first = tab(locks);
    const second = tab(locks);

    await flush();

    expect(first.leading()).toBe(true);
    expect(second.leading()).toBe(false);
  });

  it("hands the lead to a tab that takes it, and back once that tab leaves", async () => {
    const locks = new MemoryLocks();
    const first = tab(locks);
    const second = tab(locks);

    await flush();
    await second.lead.take();
    await flush();

    expect(second.leading()).toBe(true);
    expect(first.leading()).toBe(false);

    second.lead.stop();
    await flush();

    expect(first.leading()).toBe(true);
    expect(first.states).toStrictEqual([true, false, true]);
  });

  it("passes the lead on when the leading tab leaves", async () => {
    const locks = new MemoryLocks();
    const first = tab(locks);
    const second = tab(locks);

    await flush();
    first.lead.stop();
    await flush();

    expect(second.leading()).toBe(true);
  });

  it("lets go at once of a lead taken just before the tab left, and the other tab leads again", async () => {
    const locks = new MemoryLocks();
    const first = tab(locks);
    const second = tab(locks);

    await flush();
    void second.lead.take();
    second.lead.stop();
    await flush();
    await flush();

    expect(second.states).toStrictEqual([]);
    expect(first.leading()).toBe(true);
  });

  it("leads at once without Web Locks", () => {
    const only = tab(undefined);

    expect(only.leading()).toBe(true);
  });
});
