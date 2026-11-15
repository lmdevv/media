import { describe, expect, it, vi } from "vitest";

import { ConnectPlayer } from "./connect-player";
import type { ReportedSong } from "./connect-player";
import { followLead, speakForDevice } from "./tab-lead";
import type { TabLocks } from "./tab-lead";
import { entry, queueOf, settle, setup } from "./testing/controller-harness";

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
  const states: Array<string> = [];

  const lead = followLead(locks, "lead", (role) => {
    states.push(role);
  });

  return { lead, leading: () => states.at(-1) === "leading", states };
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
    expect(first.states).toStrictEqual(["leading", "taken", "leading"]);
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

/**
 * A tab of one browser over the real Web Locks API: its own player and Connect's device side,
 * speaking for the browser's device through `speakForDevice` while it leads.
 */
const speakingTab = (name: string) => {
  const run = setup();
  const reports: Array<ReportedSong | null> = [];

  const player = new ConnectPlayer(
    run.controller,
    {
      report: async (song) => {
        reports.push(song);

        return run.clock.now;
      },
      albumTracks: async () => [],
    },
    { now: () => run.clock.now, every: () => () => undefined },
  );

  const states: Array<boolean> = [];

  const lead = speakForDevice(
    navigator.locks,
    name,
    { player, controller: run.controller },
    (leading) => {
      states.push(leading);
    },
  );

  return { ...run, player, lead, reports, leading: () => states.at(-1) === true };
};

const song = { domain: "music", ref: { type: "track", id: "a" } } as const;

describe("speakForDevice", () => {
  it("lets go of a tab's song once another tab takes the lead, so a remote pause stops all the browser plays", async () => {
    const name = `connect-${crypto.randomUUID()}`;
    const first = speakingTab(name);
    const second = speakingTab(name);

    await vi.waitFor(() => {
      expect(first.leading()).toBe(true);
    });

    for (const run of [first, second]) run.controller.sync(queueOf([entry("a", "1")], "1"));
    first.controller.playCurrentAt("a", 0, true);
    await settle();
    second.controller.playCurrentAt("a", 0, true);
    await second.lead.take();

    await vi.waitFor(() => {
      expect(first.player.started).toBe(false);
    });

    expect(first.controller.playingHere()).toBeNull();
    expect(first.reports.at(-1)).toMatchObject({ trackId: "a", playing: true });
    expect(second.player.started).toBe(true);

    second.player.take({
      revision: 1,
      ask: { kind: "transport", item: song, playing: false, positionMs: 0, at: second.clock.now },
    });
    await settle();

    expect(second.controller.playingHere()).toMatchObject({ trackId: "a", playing: false });
    expect(first.controller.playingHere()).toBeNull();

    first.lead.stop();
    second.lead.stop();
  });

  it("keeps a tab's song when it leaves the election, as when its page closes", async () => {
    const only = speakingTab(`connect-${crypto.randomUUID()}`);

    await vi.waitFor(() => {
      expect(only.leading()).toBe(true);
    });

    only.controller.sync(queueOf([entry("a", "1")], "1"));
    only.controller.playCurrentAt("a", 0, true);
    await settle();
    only.lead.stop();

    expect(only.player.started).toBe(false);
    expect(only.controller.playingHere()).toMatchObject({ trackId: "a", playing: true });
  });
});
