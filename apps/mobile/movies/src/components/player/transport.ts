import { Predicate } from "effect";

import type { PlayerPhase } from "./playback-controller";

/** What the centre of the player controls shows: a spinner while the video loads, else play or pause. */
export type Transport =
  | {
      readonly kind: "loading";
      /** A line under the spinner when loading means something went wrong, such as `Reconnecting…`. */
      readonly note: string | null;
    }
  | { readonly kind: "ready"; readonly playing: boolean };

/** What the player screen knows when it picks the transport. */
export interface TransportInput {
  readonly phase: PlayerPhase;
  /** The start failed or playback stopped, so the stopped panel covers the player. */
  readonly stopped: boolean;
  /** The video port's own state. */
  readonly playing: boolean;
  readonly buffering: boolean;
  /** The controller is reconnecting a stream that dropped. */
  readonly recovering: boolean;
}

/**
 * The transport for the player controls: loading while the stream prepares or the video buffers,
 * else play or pause. `null` when playback stopped and no controls belong over the player.
 */
export const transportOf = (input: TransportInput): Transport | null => {
  if (input.stopped || Predicate.isTagged(input.phase, "Stopped")) return null;

  if (Predicate.isTagged(input.phase, "Preparing") || input.buffering) {
    return { kind: "loading", note: input.recovering ? "Reconnecting…" : null };
  }

  return { kind: "ready", playing: input.playing };
};
