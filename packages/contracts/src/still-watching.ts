/**
 * "Are you still watching?": a viewer who falls asleep shouldn't have autoplay run episodes all
 * night. The player counts autoplay's jumps to the next episode since the viewer last clicked,
 * pressed a key or tapped. On the jump that would make `ASK_ON_JUMP` in a row it asks instead of
 * starting the episode, and with no answer within `CLOSE_AFTER_MS` it closes. A group session
 * never asks: the host's client moves everyone on.
 */

/** The autoplay jump, counted from the viewer's last input, that asks instead of playing. */
export const ASK_ON_JUMP = 3;

/** How long the question waits for an answer before the player closes. */
export const CLOSE_AFTER_MS = 120_000;

/** Whether the viewer is presumed watching, and since when the player has been asking. */
export type StillWatching =
  | {
      readonly state: "watching";
      /** Autoplay jumps to the next episode since the viewer's last input. */
      readonly jumps: number;
    }
  | {
      readonly state: "asking";
      /** When the question appeared, in wall-clock ms. */
      readonly since: number;
    };

/** A viewer who just did something. */
export const WATCHING: StillWatching = { state: "watching", jumps: 0 };

/**
 * The viewer clicked, pressed a key or tapped in the player, which resets the count. Input while
 * the question shows counts only through its buttons.
 */
export const viewerActed = (watching: StillWatching): StillWatching =>
  watching.state === "asking" ? watching : WATCHING;

/** What the end of autoplay's countdown does: play the next episode, or ask first. */
export interface AutoplayStep {
  /** Start the next episode now; false shows the question instead. */
  readonly play: boolean;
  readonly next: StillWatching;
}

/** Autoplay's countdown ran out with no input since `watching`. */
export const autoplayDue = (watching: StillWatching, now: number): AutoplayStep => {
  if (watching.state === "asking") return { play: false, next: watching };

  const jumps = watching.jumps + 1;

  return jumps >= ASK_ON_JUMP
    ? { play: false, next: { state: "asking", since: now } }
    : { play: true, next: { state: "watching", jumps } };
};

/** Whether the question has waited long enough that the player closes. */
export const unanswered = (watching: StillWatching, now: number): boolean =>
  watching.state === "asking" && now - watching.since >= CLOSE_AFTER_MS;

/** How long the question has left before the player closes, or null when it isn't showing. */
export const closesInMs = (watching: StillWatching, now: number): number | null =>
  watching.state === "asking" ? Math.max(0, CLOSE_AFTER_MS - (now - watching.since)) : null;
