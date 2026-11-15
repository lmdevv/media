import { Option } from "effect";

import { withDeadline } from "./deadline";
import type { HandBackStep } from "./local-queue";

/** One hand-back of this phone's own queue to the core (`handBack`'s steps). */
export interface HandOver {
  readonly steps: ReadonlyArray<HandBackStep>;
  /** Sends one step. A new queue answers the entry the core opened it on; the others null. */
  readonly send: (step: HandBackStep) => Promise<string | null>;
  /** The entry this phone plays, by the id its own queue gives it, or null. */
  readonly playing: string | null;
  /** Whether this hand-back still stands: a second outage meanwhile keeps the phone's queue. */
  readonly stands: () => boolean;
  /** Gives the entry loaded here the id the core now holds it under (`adoptEntry`). */
  readonly adopt: (fromItemId: string, toItemId: string) => void;
  /** Moves the player onto the core's queue. */
  readonly follow: () => void;
  /** How long the steps may take to settle before the phone stops waiting for them. */
  readonly deadlineMs: number;
  /**
   * Gives up on this hand-back when its steps did not settle in time: commands go to the phone's
   * own queue again, and the hand-back is tried again later.
   */
  readonly release: () => void;
}

/**
 * Sends the hand-back, and moves the player onto the core's queue only once every step settled.
 * The core still holds the queue as it was before the outage until then, so following it sooner
 * would load the song it last knew and drop the one paused here, which then came back from the
 * start. Convex answers a mutation once its queries show it, so the core's queue then names the
 * entry this phone plays, and the song stays where it is. A new queue's entries get new ids, so
 * the song loaded here takes the id the core answered.
 *
 * Old music did the same: its router kept showing the phone's own session while it reconciled,
 * and sent the position with it (`devices.reconcile`). The core's queue keeps no position, so the
 * phone keeps it.
 *
 * A step that never settles, as when the media server answers but the core does not, would hold
 * the player on the phone's queue while commands go to the core. Past `deadlineMs` the phone stops
 * waiting and `release` hands commands back to its own queue, as the outage left them.
 */
export const handOver = async ({
  steps,
  send,
  playing,
  stands,
  adopt,
  follow,
  deadlineMs,
  release,
}: HandOver): Promise<void> => {
  // Sent together, in order: Convex runs one client's mutations in the order they were sent. One
  // refused step leaves the others: each changes only what it names.
  const settled = await withDeadline(Promise.allSettled(steps.map(send)), deadlineMs);

  if (!stands()) return;

  if (Option.isNone(settled)) {
    release();

    return;
  }

  const answers = settled.value;

  for (const answer of answers) {
    if (playing !== null && answer.status === "fulfilled" && answer.value !== null) {
      adopt(playing, answer.value);
    }
  }

  follow();
};
