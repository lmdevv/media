import { moveArrived } from "@media/player/connect-devices";
import type { Device } from "@media/player/connect-devices";

/** How long a move may wait for the device it went to to answer it. */
export const TRANSFER_TIMEOUT_MS = 10_000;

const TIMED_OUT_MESSAGE = "That device didn’t respond. Check that it’s online and try again.";

/** The move target that is this phone. */
export const HERE = "here";

/** Where playback can move: this phone (`HERE`), or one of the person's other devices by its id. */
export type MoveTarget = string;

/** One end of a move, as the device sheet listed it when the move started. */
export interface MoveEnd {
  readonly target: MoveTarget;
  /** The device's name then, kept for a device that leaves the list; this phone's is unused. */
  readonly name: string;
}

/** A move the listener started, from the device that played to the one they picked. */
export interface Move {
  /** Tells this move from the listener's earlier ones, whose outcomes change nothing. */
  readonly id: number;
  readonly from: MoveEnd;
  readonly to: MoveEnd;
}

/** No move, one on its way, or one that failed. */
export type Transfer =
  | { readonly state: "idle" }
  /** On its way: `landed` once the core took it, and then waiting for the device to answer it. */
  | { readonly state: "pending"; readonly move: Move; readonly landed: boolean }
  /**
   * Refused, or unanswered: `landed` once the core took it, before the failure or after, which
   * stopped the device it went from, so staying there means moving back.
   */
  | {
      readonly state: "failed";
      readonly move: Move;
      readonly message: string;
      readonly landed: boolean;
    };

/** What happens to a move. Each but `start` and `dismiss` names the move it is about. */
export type TransferEvent =
  /** The listener picked a device. */
  | { readonly type: "start"; readonly move: Move }
  /** The core took the move. */
  | { readonly type: "landed"; readonly id: number }
  /** The device the move went to answered it (`moveArrived`). */
  | { readonly type: "arrived"; readonly id: number }
  /** The core refused the move. */
  | { readonly type: "refused"; readonly id: number; readonly message: string }
  /** The move waited `TRANSFER_TIMEOUT_MS` for its device to answer it. */
  | { readonly type: "timeout"; readonly id: number }
  /** The sheet closed, or the listener closed its failure. A pending move goes on unwatched. */
  | { readonly type: "dismiss" };

/** No move on its way, and none failed. */
export const idleTransfer: Transfer = { state: "idle" };

/**
 * The move after `event`. What happens to a move other than the one shown changes nothing, and a
 * move counts as arrived only once the core took it. Both count even after the move failed here,
 * as when the core answers after the timeout: a failed move whose device then answers it is done.
 */
export const nextTransfer = (transfer: Transfer, event: TransferEvent): Transfer => {
  if (event.type === "start") return { state: "pending", move: event.move, landed: false };

  if (event.type === "dismiss") return idleTransfer;

  if (transfer.state === "idle" || event.id !== transfer.move.id) return transfer;

  if (event.type === "landed") return { ...transfer, landed: true };

  if (event.type === "arrived") return transfer.landed ? idleTransfer : transfer;

  if (transfer.state !== "pending") return transfer;

  return {
    state: "failed",
    move: transfer.move,
    message: event.type === "refused" ? event.message : TIMED_OUT_MESSAGE,
    landed: transfer.landed,
  };
};

/**
 * Whether the move in `transfer`, pending or failed, has reached its device, as Connect shows it
 * now: the core took it, and this phone holds the song, or the other device answered it with its
 * own report.
 */
export const transferArrived = (
  transfer: Transfer,
  connect: { readonly here: boolean; readonly devices: ReadonlyArray<Device> },
): boolean =>
  transfer.state !== "idle" &&
  moveArrived(
    {
      deviceId: transfer.move.to.target === HERE ? null : transfer.move.to.target,
      landed: transfer.landed,
    },
    connect,
  );
