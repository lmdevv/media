import type { AudioOutput, LockScreenInfo, OutputControl, OutputStatus } from "./native-engine";

const settled = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * A native player for the engine's tests: it plays, pauses, and seeks as told and reports each
 * change, as expo-audio does. A test calls `play` or `pause` on it directly for what the lock
 * screen, Control Center, headphones, or CarPlay do to the AVPlayer itself.
 */
export class FakeOutput implements AudioOutput {
  readonly url: string;
  readonly id: string;
  wantsPlay = false;
  loaded = false;
  live = false;
  durationMs = 0;
  positionMs = 0;
  released = false;
  holdSeeks = false;
  reportSeeks = true;
  lockScreen: { readonly info: LockScreenInfo | null; readonly live: boolean } | null = null;
  readonly #listeners = new Set<(status: OutputStatus) => void>();
  readonly #heldSeeks: Array<{ readonly land: () => void; readonly refuse: () => void }> = [];

  constructor(url: string, id: string) {
    this.url = url;
    this.id = id;
  }

  samplePlayback = (): Pick<OutputStatus, "positionMs" | "control"> => ({
    positionMs: this.positionMs,
    control: this.#control(),
  });

  play = (): void => {
    this.wantsPlay = true;
    this.#report();
  };

  pause = (): void => {
    this.wantsPlay = false;
    this.#report();
  };

  seek = async (positionMs: number): Promise<void> => {
    if (this.holdSeeks) {
      await new Promise<void>((resolve, reject) => {
        this.#heldSeeks.push({ land: resolve, refuse: () => reject(new Error("seek refused")) });
      });
    }

    if (!this.live) this.positionMs = positionMs;

    if (this.reportSeeks) this.#report();
  };

  setVolume = (): void => {};

  showOnLockScreen = (info: LockScreenInfo | null, live: boolean): void => {
    this.lockScreen = { info, live };
  };

  subscribe = (listener: (status: OutputStatus) => void): (() => void) => {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  };

  release = (): void => {
    this.released = true;
  };

  ready(live: boolean, durationMs = 200_000): void {
    this.loaded = true;
    this.live = live;
    this.durationMs = durationMs;
    this.#report();
  }

  advance(ms: number): void {
    this.positionMs += ms;
    this.#report();
  }

  finish(): void {
    this.wantsPlay = false;
    this.positionMs = this.live ? 0 : this.durationMs;
    this.#report({ finished: true, positionMs: this.live ? 0 : this.durationMs });
  }

  async landSeeksNewestFirst(): Promise<void> {
    const held = this.#heldSeeks.pop();

    if (held === undefined) return;
    held.land();
    await settled();
    await this.landSeeksNewestFirst();
  }

  async refuseOldestSeek(): Promise<void> {
    this.#heldSeeks.shift()?.refuse();
    await settled();
  }

  reportEndLate(): void {
    this.wantsPlay = false;
    this.#report({ finished: true });
  }

  /** Reports the player's state, unchanged, as expo-audio does every 250 ms while it is open. */
  tick(): void {
    this.#report();
  }

  notifyPlayingLate(): void {
    this.#report({ control: "playing", positionMs: 0 });
  }

  fail(message: string): void {
    this.#report({ error: message });
  }

  #control(): OutputControl {
    if (!this.wantsPlay) return "paused";

    return this.loaded ? "playing" : "waiting";
  }

  #report(patch: Partial<OutputStatus> = {}): void {
    const status: OutputStatus = {
      loaded: this.loaded,
      control: this.#control(),
      positionMs: this.positionMs,
      durationMs: this.loaded && !this.live ? this.durationMs : null,
      finished: false,
      error: null,
      ...patch,
    };

    for (const listener of this.#listeners) listener(status);
  }
}
