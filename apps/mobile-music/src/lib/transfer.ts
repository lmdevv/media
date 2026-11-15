/** How long a move may wait for the device it went to to play. */
export const TRANSFER_TIMEOUT_MS = 10_000;

const TIMED_OUT_MESSAGE = "That device didn’t respond. Check that it’s online and try again.";

/** The target that is this phone; the core's device ids never read so. */
export const HERE = "here";

/** Where playback can move: this phone (`HERE`), or one of the person's other devices by its id. */
export type MoveTarget = string;

/** No move, one on its way to `to`, or one that failed (playback stayed where it was). */
export type Transfer =
  | { readonly state: "idle" }
  | { readonly state: "pending"; readonly to: MoveTarget }
  | { readonly state: "failed"; readonly to: MoveTarget; readonly message: string };

/** What happens to a move. */
export type TransferEvent =
  /** The listener picked `to`. */
  | { readonly type: "start"; readonly to: MoveTarget }
  /** Connect shows `active` playing: this phone, another device, or none (null). */
  | { readonly type: "active"; readonly active: MoveTarget | null }
  /** The core refused the move to `to`. */
  | { readonly type: "refused"; readonly to: MoveTarget; readonly message: string }
  /** The move to `to` waited `TRANSFER_TIMEOUT_MS` for that device to play. */
  | { readonly type: "timeout"; readonly to: MoveTarget }
  /** The listener closed the failure. */
  | { readonly type: "dismiss" };

export const idleTransfer: Transfer = { state: "idle" };

/**
 * The move after `event`, as old music's device sheet tracked one. Events about an older move than
 * the pending one change nothing.
 */
export const nextTransfer = (transfer: Transfer, event: TransferEvent): Transfer => {
  if (event.type === "start") return { state: "pending", to: event.to };

  if (event.type === "dismiss") return idleTransfer;

  if (transfer.state !== "pending") return transfer;

  if (event.type === "active") return event.active === transfer.to ? idleTransfer : transfer;

  if (event.to !== transfer.to) return transfer;

  return {
    state: "failed",
    to: event.to,
    message: event.type === "refused" ? event.message : TIMED_OUT_MESSAGE,
  };
};
