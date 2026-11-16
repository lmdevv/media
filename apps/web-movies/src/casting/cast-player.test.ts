import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CastFramework,
  RemotePlayer,
  RemotePlayerChange,
  RemotePlayerController,
} from "./cast-api";
import { CastPlayer } from "./cast-player";

const ANY_CHANGE = "anyChanged";

/** The stream this cast loaded on the receiver. */
const OWN = "http://nas.lan:8080/media/hls/own/1/index.m3u8";

/** A movie a second tab cast to the same receiver. */
const OTHER = "http://nas.lan:8080/media/hls/other/1/index.m3u8";

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
  let mirrorTime = 30;
  let media: { readonly contentId: string } | null = { contentId: OWN };
  let stops = 0;
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

    get mediaInfo(): { readonly contentId: string } | null {
      return media;
    }

    get currentTime(): number {
      return mirrorTime;
    }

    set currentTime(value: number) {
      mirrorTime = value;
    }

    readonly canControlVolume = true;
    readonly duration = 600;
    readonly playerState = "PLAYING";
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

    stop(): void {
      stops += 1;
    }

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
    stops: () => stops,
    /** A sender, this cast or another, puts `contentId` on the receiver, as the mirror tells. */
    mediaArrives: (contentId: string) => {
      media = { contentId };

      for (const handler of handlers) handler({ field: "mediaInfo", value: media });
    },
    /** The mirror reports the receiver at `seconds`. */
    reachTime: (seconds: number) => {
      mirrorTime = seconds;

      for (const handler of handlers) handler({ field: "currentTime", value: seconds });
    },
    /** The mirror reports the receiver paused or playing, whatever toggles are on their way. */
    reachPaused: (paused: boolean) => {
      mirrorPaused = paused;
      receiverPaused = paused;

      for (const handler of handlers) handler({ field: "isPaused", value: paused });
    },
  };
};

const castPlayer = (framework: CastFramework, taken: () => void = () => undefined): CastPlayer =>
  new CastPlayer(
    framework,
    OWN,
    () => Promise.resolve(),
    () => null,
    () => undefined,
    taken,
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("CastPlayer", () => {
  it("lets the receiver be once a second tab's movie takes it, and keeps where this cast was", () => {
    const receiver = laggingReceiver();
    const taken: Array<true> = [];
    const player = castPlayer(receiver.framework, () => taken.push(true));
    const heard: Array<string> = [];

    player.subscribe((event) => heard.push(event));
    receiver.reachTime(40);
    receiver.mediaArrives(OTHER);
    receiver.reachTime(3605);
    receiver.reachPaused(true);

    expect(taken).toHaveLength(1);
    expect(heard).toStrictEqual([]);
    expect(player.positionMs()).toBe(40_000);

    player.stopReceiver();

    expect(receiver.stops()).toBe(0);
  });

  it("says nothing of the media before its newest load until that load shows", () => {
    const receiver = laggingReceiver();
    const taken: Array<true> = [];
    const player = castPlayer(receiver.framework, () => taken.push(true));
    const next = "http://nas.lan:8080/media/hls/own/2/index.m3u8";

    receiver.reachTime(40);
    // The cast loads a new generation; the receiver still shows the last one meanwhile.
    player.expect(next);
    receiver.reachTime(3605);

    expect(taken).toStrictEqual([]);
    expect(player.positionMs()).toBe(40_000);

    receiver.mediaArrives(next);
    receiver.reachTime(41);

    expect(player.positionMs()).toBe(41_000);
  });

  it("takes a late report of its own older load for the media before, not another tab's", () => {
    const receiver = laggingReceiver();
    const taken: Array<true> = [];
    const player = castPlayer(receiver.framework, () => taken.push(true));
    const french = "http://nas.lan:8080/media/hls/own/2/index.m3u8";
    const english = "http://nas.lan:8080/media/hls/own/3/index.m3u8";

    // Two audio changes load one after the other; the receiver reports the first one late.
    player.expect(french);
    player.expect(english);
    receiver.mediaArrives(french);

    expect(taken).toStrictEqual([]);

    receiver.mediaArrives(english);
    receiver.reachTime(12);

    expect(player.positionMs()).toBe(12_000);
  });

  it("lets the receiver be when another tab loads before the cast's newest media shows", () => {
    const receiver = laggingReceiver();
    const taken: Array<true> = [];
    const player = castPlayer(receiver.framework, () => taken.push(true));

    player.expect("http://nas.lan:8080/media/hls/own/2/index.m3u8");
    receiver.mediaArrives(OTHER);

    expect(taken).toHaveLength(1);
  });

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
