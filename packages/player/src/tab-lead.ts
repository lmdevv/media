import type { ConnectPlayer } from "./connect-player";
import type { PlaybackController } from "./playback-controller";

/** The part of the Web Locks API (`navigator.locks`) that {@link followLead} uses. */
export interface TabLocks {
  readonly request: (
    name: string,
    options: { readonly signal?: AbortSignal; readonly steal?: boolean },
    callback: () => Promise<void>,
  ) => Promise<void>;
}

/**
 * Where a tab stands in the election {@link followLead} runs: it leads; another tab took the lead
 * from it, and it waits to lead again; or it is out, before it first leads or once it left.
 */
type TabRole = "leading" | "taken" | "out";

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
 * it waits to lead again. Without Web Locks every tab leads.
 *
 * @param onChange - Called with the tab's role each time it changes: `leading` once it leads,
 *   `taken` once another tab took the lead from it, and `out` once it left the election.
 */
export const followLead = (
  locks: TabLocks | undefined,
  name: string,
  onChange: (role: TabRole) => void,
): TabLead => {
  if (locks === undefined) {
    let left = false;

    onChange("leading");

    return {
      take: async () => undefined,
      stop: () => {
        if (left) return;
        left = true;
        onChange("out");
      },
    };
  }

  let role: TabRole = "out";
  let stopped = false;
  let waiting: AbortController | null = null;
  let release: (() => void) | null = null;
  let waiters: Array<() => void> = [];

  const settleWaiters = (): void => {
    const settled = waiters;

    waiters = [];

    for (const resolve of settled) resolve();
  };

  const become = (next: TabRole): void => {
    if (next === "leading") settleWaiters();

    if (next === role) return;
    role = next;
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

        // A steal can't be aborted, so one granted after `stop` lets go at once.
        if (stopped) return;

        await new Promise<void>((resolve) => {
          held = resolve;
          release = resolve;
          become("leading");
        });
      })
      .catch(() => {
        // Aborted while waiting, which needs nothing, or the lead was taken from this tab.
        if (held === null || release !== held) return;
        release = null;
        become("taken");

        if (!stopped) ask(false);
      });
  };

  ask(false);

  return {
    take: async () => {
      if (role === "leading" || stopped) return;

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
      become("out");
      settleWaiters();
    },
  };
};

/** What a tab starts while it leads, and whose song it lets go of once another tab leads. */
interface DeviceVoice {
  readonly player: Pick<ConnectPlayer, "start">;
  readonly controller: Pick<PlaybackController, "release">;
}

/**
 * Speaks for the browser's device from this tab while it leads {@link followLead}'s election
 * (ADR 0018): `voice.player` reports and applies Connect's requests only then. When another tab
 * takes the lead, this tab stops speaking and then lets go of its song, so the browser never plays
 * audio that its device neither reports nor obeys.
 *
 * @param onLeading - Called with whether this tab leads, once it started or stopped speaking.
 */
export const speakForDevice = (
  locks: TabLocks | undefined,
  name: string,
  voice: DeviceVoice,
  onLeading: (leading: boolean) => void,
): TabLead => {
  let stopSpeaking: (() => void) | null = null;

  return followLead(locks, name, (role) => {
    stopSpeaking?.();
    stopSpeaking = role === "leading" ? voice.player.start() : null;

    if (role === "taken") voice.controller.release();
    onLeading(role === "leading");
  });
};
