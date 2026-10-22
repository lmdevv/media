/**
 * Moving playback to another device, as the device list shows it. The server moves the session
 * at once; the move counts as done when the session names the new device, and as failed when the
 * server refuses it or the session does not follow within `TRANSFER_TIMEOUT_MS`.
 */
import type { DeviceId } from "@music/commands/ids";

/** How long a move may wait for the session to name its device. */
export const TRANSFER_TIMEOUT_MS = 10_000;

const TIMED_OUT_MESSAGE = "That device didn't respond. Check that it's online and try again.";

/** No move, one on its way to `to`, or one that failed (playback stayed where it was). */
export type Transfer =
  | { readonly state: "idle" }
  | { readonly state: "pending"; readonly to: DeviceId }
  | { readonly state: "failed"; readonly to: DeviceId; readonly message: string };

/** What happens to a move. */
export type TransferEvent =
  /** The listener picked `to`. */
  | { readonly type: "start"; readonly to: DeviceId }
  /** A session snapshot names `activeId` as the playing device. */
  | { readonly type: "session"; readonly activeId: DeviceId | null }
  /** The server refused the move to `to`. */
  | { readonly type: "refused"; readonly to: DeviceId; readonly message: string }
  /** The move to `to` waited `TRANSFER_TIMEOUT_MS` for the session. */
  | { readonly type: "timeout"; readonly to: DeviceId }
  /** The listener closed the failure. */
  | { readonly type: "dismiss" };

export const idleTransfer: Transfer = { state: "idle" };

/** The move after `event`. Events about an older move than the pending one change nothing. */
export const nextTransfer = (transfer: Transfer, event: TransferEvent): Transfer => {
  if (event.type === "start") return { state: "pending", to: event.to };

  if (event.type === "dismiss") return idleTransfer;

  if (transfer.state !== "pending") return transfer;

  if (event.type === "session") return event.activeId === transfer.to ? idleTransfer : transfer;

  if (event.to !== transfer.to) return transfer;

  return {
    state: "failed",
    to: event.to,
    message: event.type === "refused" ? event.message : TIMED_OUT_MESSAGE,
  };
};
