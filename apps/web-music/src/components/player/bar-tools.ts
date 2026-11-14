import type { PlayerStatus } from "@media/player/react";

/**
 * What the right side of the desktop player bar shows: the stream error, nothing while the media
 * service is unreachable, "Buffering…", or its tools (quality, queue, volume).
 */
export type BarTools = "error" | "offline" | "buffering" | "tools";

/** The player state the bar's right side depends on. */
export interface BarToolsInput {
  readonly status: PlayerStatus;
  readonly mediaOnline: boolean;
}

/** Picks what the desktop player bar's right side shows for the current player state. */
export const barTools = ({ status, mediaOnline }: BarToolsInput): BarTools => {
  if (!mediaOnline) return "offline";

  if (status === "error") return "error";

  if (status === "buffering" || status === "loading") return "buffering";

  return "tools";
};
