/**
 * The SDK's `PlayerPort` over a Chromecast: positions and state come from the Cast SDK's mirror of
 * the receiver's player (`RemotePlayer`), and commands go through its `RemotePlayerController`. A
 * seek goes through `move`, which knows whether the receiver can seek by itself (a direct file) or
 * needs the stream moved first (HLS); until it lands, the player reports the target and counts as
 * buffering, as the element player does. Receivers play at normal speed only (`fixedRate`), so
 * the room engine corrects drift by seeking.
 *
 * The mirror names the media it describes, and only this cast's newest load is this player's
 * (ADR 0018): the media before it, or another sender's, such as a second tab's movie or a song cast
 * from `/music`, says nothing. Once another sender's media takes the receiver from this cast's,
 * `taken` hears it, and the player follows the receiver no more.
 */
import type { PlayerEvent, PlayerPort } from "@media/sdk/effect";
import type { LiveValue } from "@media/ui/lib/live-value";

import type {
  CastFramework,
  RemotePlayer,
  RemotePlayerChange,
  RemotePlayerController,
} from "./cast-api";

/** The receiver's player states, as the SDK names them. */
const BUFFERING = "BUFFERING";

const IDLE = "IDLE";

/** Why a receiver went idle: its media played to the end, or it failed to play on. */
const FINISHED = "FINISHED";

const ERROR = "ERROR";

/** How many of its own loads' media a cast remembers, to tell a late report from another sender. */
const OWN_MEDIA_KEPT = 32;

/** How long a play or pause may take to show in the receiver's mirror before it counts as lost. */
const TOGGLE_TIMEOUT_MS = 5_000;

/** What the controls draw while casting, apart from the position ({@link CastPlayer.position}). */
export interface RemoteState {
  readonly paused: boolean;
  readonly ended: boolean;
  readonly buffering: boolean;
  readonly volume: number;
  readonly muted: boolean;
  /** Whether the page can set the receiver's volume; mute works either way. */
  readonly volumeSettable: boolean;
}

const sameRemoteState = (left: RemoteState, right: RemoteState): boolean =>
  left.paused === right.paused &&
  left.ended === right.ended &&
  left.buffering === right.buffering &&
  left.volume === right.volume &&
  left.muted === right.muted &&
  left.volumeSettable === right.volumeSettable;

/** The media a cast loaded on the receiver, as the mirror names it. */
interface OwnMedia {
  readonly contentId: string;
  /** Whether the mirror has named it since it was loaded. */
  readonly shown: boolean;
  /** What the mirror named as it was loaded: the media before it. */
  readonly before: string | null;
}

/** A Chromecast's player as the progress reporter, the room engine, and the controls see it. */
export class CastPlayer implements PlayerPort {
  readonly #remote: RemotePlayer;
  readonly #controller: RemotePlayerController;
  readonly #changeEvent: string;
  readonly #move: (positionMs: number, signal: AbortSignal) => Promise<void>;
  readonly #idleReason: () => string | null;
  readonly #failed: () => void;
  readonly #taken: () => void;
  /**
   * The media this cast loaded last, whether the mirror has shown it since, and what the mirror
   * named as it was loaded.
   */
  #own: OwnMedia;
  /** Another sender's media took the receiver: the player follows it no more. */
  #lost = false;
  /** The media this cast loaded on the receiver, newest last: a late report of one is its own. */
  readonly #loaded: Array<string> = [];
  readonly #listeners = new Set<(event: PlayerEvent) => void>();
  readonly #watchers = new Set<() => void>();
  #pending: number | null = null;
  /**
   * Whether the receiver should be paused (true) or playing (false), until its mirror shows it.
   * Commands only toggle and the mirror lags, so what was asked is kept here and reached one toggle
   * at a time.
   */
  #wanted: boolean | null = null;
  /** The pause or play listeners last heard, so they hear each change once. */
  #reported: boolean | null = null;
  /** A toggle is on its way; the next pause or play the mirror reports is its outcome. */
  #toggling: ReturnType<typeof setTimeout> | null = null;
  /**
   * Whether the receiver should be muted, until its mirror shows it. As with play and pause, the
   * controller only toggles, from what the mirror says, so toggles go one at a time: a second sent
   * before the mirror shows the first would repeat it rather than undo it.
   */
  #muteWanted: boolean | null = null;
  /** A mute toggle is on its way; given up on, and the mirror trusted again, after a while. */
  #muteToggling: ReturnType<typeof setTimeout> | null = null;
  #moving: AbortController | null = null;
  #ended = false;
  /** Where the receiver was when this player was disposed; reports read it from then on. */
  #final: number | null = null;
  /** Where the receiver was and whether it was paused while connected; a disconnect resets the mirror. */
  #last = { positionMs: 0, paused: true };
  #state: RemoteState;
  #positionSeconds: number;

  /**
   * @param contentId - The media the cast loaded on the receiver.
   * @param move - Moves the receiver to a position, aborting when a newer seek replaces it.
   * @param idleReason - Why the receiver's media last went idle, or null.
   * @param failed - Hears that the receiver stopped because its media failed (a download error).
   * @param taken - Hears that another sender's media took the receiver from this cast's.
   */
  constructor(
    framework: CastFramework,
    contentId: string,
    move: (positionMs: number, signal: AbortSignal) => Promise<void>,
    idleReason: () => string | null,
    failed: () => void,
    taken: () => void,
  ) {
    this.#remote = new framework.RemotePlayer();
    this.#controller = new framework.RemotePlayerController(this.#remote);
    this.#changeEvent = framework.RemotePlayerEventType.ANY_CHANGE;
    this.#move = move;
    this.#idleReason = idleReason;
    this.#failed = failed;
    this.#taken = taken;
    const named = this.#remote.mediaInfo?.contentId ?? null;

    this.#own = { contentId, shown: named === contentId, before: named };
    this.#loaded.push(contentId);
    this.#state = this.#read();
    this.#positionSeconds = this.positionMs() / 1000;
    this.#controller.addEventListener(this.#changeEvent, this.#onChange);
  }

  /** Receivers play at normal speed only. */
  readonly fixedRate = true;

  /**
   * Stops following the receiver and keeps reporting where it was, so a report made afterwards
   * (the session's exit report, after the receiver unloaded and its mirror reset) says where it
   * stopped.
   */
  dispose(): void {
    this.#final = this.positionMs();
    this.#moving?.abort();
    this.#settleToggle();
    this.#settleMuteToggle();
    this.#muteWanted = null;
    this.#wanted = null;
    this.#controller.removeEventListener(this.#changeEvent, this.#onChange);
    this.#listeners.clear();
    this.#watchers.clear();
  }

  /** The cast loads `contentId` on the receiver: from now on, only that media is this player's. */
  expect(contentId: string): void {
    this.#own = { contentId, shown: false, before: this.#remote.mediaInfo?.contentId ?? null };
    this.#loaded.push(contentId);

    if (this.#loaded.length > OWN_MEDIA_KEPT) this.#loaded.shift();
  }

  /**
   * Whether the mirror describes this cast's newest media: it names that media, or none, as while
   * it resets.
   */
  #describes(): boolean {
    const media = this.#remote.mediaInfo?.contentId ?? null;

    return media === null || media === this.#own.contentId;
  }

  /** The receiver's state now; a new object after each change of it, the position's aside. */
  readonly getState = (): RemoteState => this.#state;

  /** Seconds played as of the receiver's last change, holding a seek's target until it lands. */
  readonly position: LiveValue<number> = {
    get: () => this.#positionSeconds,
    subscribe: (onChange) => this.watch(onChange),
  };

  /** Calls `onChange` after every change of the receiver's state. */
  readonly watch = (onChange: () => void): (() => void) => {
    this.#watchers.add(onChange);

    return () => {
      this.#watchers.delete(onChange);
    };
  };

  #read(): RemoteState {
    return {
      paused: this.isPaused(),
      ended: this.#ended,
      buffering: this.isBuffering(),
      volume: this.#remote.volumeLevel,
      // What was asked shows at once, so controls (and a second press) read it, not the lagging mirror.
      muted: this.#muteWanted ?? this.#remote.isMuted,
      volumeSettable: this.#remote.canControlVolume,
    };
  }

  #emit(event: PlayerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #refresh(): void {
    const next = this.#read();

    if (!sameRemoteState(this.#state, next)) this.#state = next;
    this.#positionSeconds = this.positionMs() / 1000;

    for (const watcher of this.#watchers) watcher();
  }

  readonly #onChange = (change: RemotePlayerChange): void => {
    if (this.#lost) return;

    // Mute and volume belong to the receiver, whichever media it plays.
    if (change.field === "isMuted") {
      this.#settleMuteToggle();
      this.#reconcileMute();
    }

    const media = this.#remote.mediaInfo?.contentId ?? null;

    if (media !== null && media !== this.#own.contentId) {
      // An older load of this cast's, or the media before its newest, says nothing of it. Other
      // media arriving after that load, or after its own showed, is another sender's, which took
      // the receiver.
      if (!this.#loaded.includes(media) && (this.#own.shown || media !== this.#own.before)) {
        this.#lost = true;
        this.#taken();

        return;
      }

      this.#refresh();

      return;
    }

    if (media !== null && !this.#own.shown) {
      this.#own = { ...this.#own, shown: true };
      // The mirror reports its fields one at a time: a play or pause asked meanwhile goes once
      // the rest of this media's state came.
      queueMicrotask(() => {
        this.#reconcile();
      });
    }

    // A disconnect resets the mirror (time to zero, paused), in whatever order the SDK reports
    // the fields; a jump to zero this player did not ask for is that reset, not a position.
    const reset =
      change.field === "currentTime" &&
      change.value === 0 &&
      this.#pending !== 0 &&
      this.#last.positionMs > 1_000;

    if (this.#remote.isConnected && !reset) {
      this.#last = { positionMs: this.#remote.currentTime * 1000, paused: this.#remote.isPaused };
    }

    if (change.field === "isPaused") {
      this.#settleToggle();
      this.#reconcile();
    }

    // Every pause and play the receiver goes through is reported, even one it is being toggled
    // away from: the room engine hears one echo for each pause it asks for.
    if (change.field === "isPaused" && this.#pending === null) {
      if (change.value === false) this.#ended = false;
      this.#reportPaused(change.value === true);
    }

    if (change.field === "playerState") {
      if (change.value === BUFFERING) this.#emit("waiting");

      // The receiver also goes idle on a stop or a new load (`CANCELLED`, `INTERRUPTED`), which
      // change nothing here: `FINISHED` ends, and `ERROR` means the media can no longer play.
      if (change.value === IDLE && this.#pending === null) {
        const reason = this.#idleReason();

        if (reason === FINISHED) {
          this.#ended = true;
          this.#emit("ended");
        }

        if (reason === ERROR) this.#failed();
      }
    }

    this.#refresh();
  };

  readonly positionMs = (): number => this.#final ?? this.#pending ?? this.receiverPositionMs();

  /** Where the receiver itself is, ignoring a seek in progress. */
  receiverPositionMs(): number {
    return this.#following() ? this.#remote.currentTime * 1000 : this.#last.positionMs;
  }

  /**
   * Paused as last asked while that is on its way to the receiver, else as its mirror says, or as
   * it last said of this cast's media.
   */
  readonly isPaused = (): boolean => {
    if (this.#following()) return this.#wanted ?? this.#remote.isPaused;

    return this.#remote.isConnected && !this.#lost
      ? (this.#wanted ?? this.#last.paused)
      : this.#last.paused;
  };

  /** Seeking, an asked play the receiver hasn't started yet, or the receiver buffering. */
  readonly isBuffering = (): boolean =>
    this.#pending !== null ||
    (this.#following() &&
      ((this.#wanted === false && this.#remote.isPaused) ||
        (!this.#remote.isPaused && this.#remote.playerState === BUFFERING)));

  /** Whether the mirror speaks of this cast's media now: connected, not taken, describing it. */
  #following(): boolean {
    return this.#remote.isConnected && !this.#lost && this.#describes();
  }

  readonly playbackRate = (): number => 1;

  readonly setPlaybackRate = (): void => undefined;

  readonly seek = (positionMs: number): void => {
    const target = Math.max(0, positionMs);
    const move = new AbortController();

    this.#moving?.abort();
    this.#moving = move;
    this.#pending = target;
    this.#emit("waiting");
    this.#refresh();

    void this.#move(target, move.signal).finally(() => {
      if (move.signal.aborted) return;
      this.#moving = null;
      this.#pending = null;
      this.#emit("seeked");
      this.#refresh();
    });
  };

  /** Seeks the receiver itself, as a direct file or the produced part of a stream allows. */
  seekInPlace(positionMs: number): void {
    this.#remote.currentTime = positionMs / 1000;
    this.#controller.seek();
  }

  readonly play = (): Promise<void> => {
    this.#ask(false);

    return Promise.resolve();
  };

  readonly pause = (): void => {
    this.#ask(true);
  };

  /** Asks for the receiver to be `paused` (or playing); reached as soon as no toggle is on its way. */
  #ask(paused: boolean): void {
    this.#wanted = paused;
    this.#reconcile();
    this.#refresh();
  }

  /**
   * Sends one toggle if the receiver isn't where it was asked to be and none is on its way. A
   * toggle whose outcome never shows (a lost command) is given up on after a while, and the mirror
   * is trusted again.
   */
  #reconcile(): void {
    if (this.#wanted === null || this.#toggling !== null || this.#lost) return;

    // The mirror's pause belongs to another's media until it describes this cast's.
    if (this.#remote.isConnected && !this.#describes()) return;

    // A receiver that is gone takes no commands; its mirror resets to paused.
    if (!this.#remote.isConnected || this.#remote.isPaused === this.#wanted) {
      this.#wanted = null;

      return;
    }

    this.#toggling = setTimeout(() => {
      this.#toggling = null;
      this.#wanted = null;

      if (this.#pending === null) this.#reportPaused(this.#remote.isPaused);
      this.#refresh();
    }, TOGGLE_TIMEOUT_MS);
    this.#controller.playOrPause();
  }

  /** Tells listeners the receiver is `paused` (or playing), unless that is what they last heard. */
  #reportPaused(paused: boolean): void {
    if (paused === this.#reported) return;
    this.#reported = paused;
    this.#emit(paused ? "paused" : "playing");
  }

  #settleToggle(): void {
    if (this.#toggling !== null) clearTimeout(this.#toggling);
    this.#toggling = null;
  }

  /**
   * Stops the receiver's media while it is media this cast loaded, or none shows; never another
   * sender's, or that of a newer cast that took the receiver first. The device stays connected.
   */
  stopReceiver(): void {
    const media = this.#remote.mediaInfo?.contentId ?? null;

    if (!this.#lost && (media === null || this.#loaded.includes(media))) this.#controller.stop();
  }

  /** Sets the receiver's volume, from 0 to 1: silence mutes it, and any other level unmutes it. */
  setVolume(volume: number): void {
    this.#remote.volumeLevel = Math.min(1, Math.max(0, volume));
    this.#controller.setVolumeLevel();
    this.#askMuted(this.#remote.volumeLevel === 0);
    this.#refresh();
  }

  /** Mutes or unmutes the receiver; what was asked shows in its state at once. */
  setMuted(muted: boolean): void {
    this.#askMuted(muted);
    this.#refresh();
  }

  #askMuted(muted: boolean): void {
    this.#muteWanted = muted;
    this.#reconcileMute();
  }

  /** Sends one mute toggle if the receiver isn't where it was asked to be and none is on its way. */
  #reconcileMute(): void {
    if (this.#muteWanted === null || this.#muteToggling !== null) return;

    if (!this.#remote.isConnected || this.#remote.isMuted === this.#muteWanted) {
      this.#muteWanted = null;

      return;
    }

    this.#muteToggling = setTimeout(() => {
      this.#muteToggling = null;
      this.#muteWanted = null;
      this.#refresh();
    }, TOGGLE_TIMEOUT_MS);
    this.#controller.muteOrUnmute();
  }

  #settleMuteToggle(): void {
    if (this.#muteToggling !== null) clearTimeout(this.#muteToggling);
    this.#muteToggling = null;
  }

  readonly subscribe = (listener: (event: PlayerEvent) => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };
}
