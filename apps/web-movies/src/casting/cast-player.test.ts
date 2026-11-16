import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CastFramework,
  RemotePlayer,
  RemotePlayerChange,
  RemotePlayerController,
} from "./cast-api";
import { CastPlayer } from "./cast-player";

const ANY_CHANGE = "anyChanged";

/**
 * A receiver whose mirror lags its commands, as a real one does over the network: `playOrPause`
 * reaches it at once, but the mirror only reports the new state on `deliver`. Mute toggles lag the
 * same way until `deliverMute`, and, as the Cast SDK's controller does, send the opposite of what
 * the mirror says, not of what the receiver is.
 */
const laggingReceiver = ({ muted = false }: { readonly muted?: boolean } = {}) => {
  const handlers = new Set<(event: RemotePlayerChange) => void>();
  let receiverPaused = false;
  let mirrorPaused = false;
  let receiverMuted = muted;
  let mirrorMuted = muted;
  let muteCommands = 0;
  // The receiver's state after each command, in order, until the mirror reports it.
  const unreported: Array<boolean> = [];
  let toggles = 0;

  /** The Cast SDK's mirror of the receiver's player. */
  class FakeRemotePlayer implements RemotePlayer {
    readonly isConnected = true;
    readonly isMediaLoaded = true;
    get isPaused(): boolean {
      return mirrorPaused;
    }

    get isMuted(): boolean {
      return mirrorMuted;
    }

    readonly canControlVolume = true;
    readonly duration = 600;
    readonly playerState = "PLAYING";
    currentTime = 30;
    volumeLevel = 1;
  }

  /** Commands reach the receiver at once; the mirror hears about them later. */
  class FakeController implements RemotePlayerController {
    playOrPause(): void {
      toggles += 1;
      receiverPaused = !receiverPaused;
      unreported.push(receiverPaused);
    }

    seek(): void {}

    stop(): void {}

    muteOrUnmute(): void {
      muteCommands += 1;
      receiverMuted = !mirrorMuted;
    }

    setVolumeLevel(): void {}

    addEventListener(_type: string, handler: (event: RemotePlayerChange) => void): void {
      handlers.add(handler);
    }

    removeEventListener(_type: string, handler: (event: RemotePlayerChange) => void): void {
      handlers.delete(handler);
    }
  }

  const framework: CastFramework = {
    CastContext: {
      getInstance: () => {
        throw new Error("The cast player never reads the context");
      },
    },
    CastContextEventType: { CAST_STATE_CHANGED: "cast", SESSION_STATE_CHANGED: "session" },
    RemotePlayer: FakeRemotePlayer,
    RemotePlayerController: FakeController,
    RemotePlayerEventType: { ANY_CHANGE },
  };

  return {
    framework,
    /** The mirror reports the receiver's next state, if one is on its way. */
    deliverOne: () => {
      const next = unreported.shift();

      if (next === undefined || next === mirrorPaused) return;
      mirrorPaused = next;

      for (const handler of handlers) handler({ field: "isPaused", value: next });
    },
    /** The mirror reports every state on its way. */
    deliver: () => {
      for (const next of unreported.splice(0)) {
        if (next === mirrorPaused) continue;
        mirrorPaused = next;

        for (const handler of handlers) handler({ field: "isPaused", value: next });
      }
    },
    /** The last command never reached the receiver. */
    loseLast: () => {
      unreported.pop();
      receiverPaused = !receiverPaused;
    },
    receiverPaused: () => receiverPaused,
    receiverMuted: () => receiverMuted,
    muteCommands: () => muteCommands,
    /** The mirror reports whether the receiver is muted now. */
    deliverMute: () => {
      if (mirrorMuted === receiverMuted) return;
      mirrorMuted = receiverMuted;

      for (const handler of handlers) handler({ field: "isMuted", value: mirrorMuted });
    },
    toggles: () => toggles,
  };
};

const castPlayer = (framework: CastFramework): CastPlayer =>
  new CastPlayer(
    framework,
    () => Promise.resolve(),
    () => null,
    () => undefined,
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("CastPlayer", () => {
  it("sends one toggle at a time, and the next once the mirror shows the first", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    await player.play();
    player.pause();
    await player.play();
    expect(receiver.toggles()).toBe(1);

    // The pause shows; the player is asked to play, so it toggles back, once.
    receiver.deliverOne();
    expect(receiver.toggles()).toBe(2);
    receiver.deliver();

    expect(receiver.receiverPaused()).toBe(false);
    expect(player.isPaused()).toBe(false);
  });

  it("reports every pause and play the receiver goes through, so each pause asked is heard", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);
    const events: Array<string> = [];

    player.subscribe((event) => {
      events.push(event);
    });
    player.pause();
    await player.play();
    receiver.deliverOne();
    receiver.deliver();

    // The room engine counts one echo per pause it asks for; this pause's must arrive.
    expect(events).toEqual(["paused", "playing"]);
  });

  it("counts an asked play as buffering until the receiver plays", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    receiver.deliver();
    await player.play();
    expect(player.isPaused()).toBe(false);
    expect(player.isBuffering()).toBe(true);
    receiver.deliver();
    expect(player.isBuffering()).toBe(false);
  });

  it("reports the receiver's real state when an asked play never takes effect", async () => {
    vi.useFakeTimers();

    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);
    const events: Array<string> = [];

    player.pause();
    receiver.deliver();
    player.subscribe((event) => {
      events.push(event);
    });
    await player.play();
    receiver.loseLast();
    vi.advanceTimersByTime(5_000);

    expect(player.isPaused()).toBe(true);
    expect(player.isBuffering()).toBe(false);
    expect(player.getState().paused).toBe(true);
    expect(events).toEqual([]);
  });

  it("trusts the mirror again when a toggle never shows", async () => {
    vi.useFakeTimers();

    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    receiver.loseLast();
    expect(player.isPaused()).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(player.isPaused()).toBe(false);

    player.pause();
    receiver.deliver();
    expect(receiver.receiverPaused()).toBe(true);
    expect(player.isPaused()).toBe(true);
  });

  it("plays again when asked before the receiver has reported an earlier pause", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    await player.play();
    receiver.deliver();

    expect(receiver.receiverPaused()).toBe(false);
    expect(player.isPaused()).toBe(false);
  });

  it("pauses again when asked before the receiver has reported an earlier play", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    receiver.deliver();
    await player.play();
    player.pause();
    receiver.deliver();

    expect(receiver.receiverPaused()).toBe(true);
    expect(player.isPaused()).toBe(true);
  });

  it("keeps a play asked after a pause while the pause's report arrives", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    await player.play();
    // The pause's report arrives; the play's is still on its way.
    receiver.deliverOne();
    await player.play();
    receiver.deliver();

    expect(receiver.receiverPaused()).toBe(false);
    expect(player.isPaused()).toBe(false);
  });

  it("follows the mirror again once it has reported every command", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    receiver.deliver();
    await player.play();
    receiver.deliver();
    player.pause();
    receiver.deliver();

    expect(receiver.receiverPaused()).toBe(true);
    expect(player.isPaused()).toBe(true);
  });

  it("reports what was asked as soon as it is asked", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.pause();
    expect(player.isPaused()).toBe(true);
    expect(player.getState().paused).toBe(true);
    await player.play();
    expect(player.isPaused()).toBe(false);
    receiver.deliverOne();
    expect(player.isPaused()).toBe(false);
  });

  it("sends nothing when asked for the state the receiver is already in", async () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    await player.play();
    player.pause();
    player.pause();
    receiver.deliver();

    expect(receiver.receiverPaused()).toBe(true);
  });

  it("unmutes once for a run of volume changes, before the mirror has caught up", () => {
    const receiver = laggingReceiver({ muted: true });
    const player = castPlayer(receiver.framework);

    // A slider drag: each step sets the volume while the mirror still says muted.
    player.setVolume(0.2);
    player.setVolume(0.3);
    expect(receiver.receiverMuted()).toBe(false);
    receiver.deliverMute();
    player.setVolume(0.5);
    expect(receiver.receiverMuted()).toBe(false);
  });

  it("mutes after a volume change the mirror has not shown yet", () => {
    const receiver = laggingReceiver({ muted: true });
    const player = castPlayer(receiver.framework);

    player.setVolume(0.4);
    player.setMuted(true);
    expect(player.getState().muted).toBe(true);
    player.setMuted(true);
    receiver.deliverMute();
    expect(receiver.receiverMuted()).toBe(true);
    receiver.deliverMute();
    expect(receiver.muteCommands()).toBe(2);
  });

  it("reports what was asked of mute and volume at once, so a second press toggles back", () => {
    const receiver = laggingReceiver({ muted: true });
    const player = castPlayer(receiver.framework);

    // m, then m again before the mirror has caught up: each press reads what the state says.
    player.setMuted(!player.getState().muted);
    expect(player.getState().muted).toBe(false);
    player.setMuted(!player.getState().muted);
    expect(player.getState().muted).toBe(true);
    receiver.deliverMute();
    expect(receiver.receiverMuted()).toBe(true);
    receiver.deliverMute();
    expect(receiver.muteCommands()).toBe(2);

    player.setVolume(0.4);
    expect(player.getState()).toMatchObject({ muted: false, volume: 0.4 });
  });

  it("mutes for silence instead of unmuting, and keeps that level for the next change", () => {
    const receiver = laggingReceiver();
    const player = castPlayer(receiver.framework);

    player.setVolume(0);
    expect(receiver.receiverMuted()).toBe(true);
    expect(player.getState()).toMatchObject({ muted: true, volume: 0 });
    player.setVolume(0.3);
    receiver.deliverMute();
    expect(receiver.receiverMuted()).toBe(false);
  });
});
