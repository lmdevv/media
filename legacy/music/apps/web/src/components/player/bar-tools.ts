import type { PlayerStatus } from "@music/player/react";

/**
 * What the right side of the desktop player bar shows: the stream error, nothing while the media
 * service is unreachable, "Buffering…", or its tools (quality, queue, Play on, volume).
 */
export type BarTools = "error" | "offline" | "buffering" | "tools";

/** The player state the bar's right side depends on. */
export interface BarToolsInput {
  readonly status: PlayerStatus;
  readonly mediaOnline: boolean;
  /** Another device plays, so this browser's own media connection doesn't matter. */
  readonly remote: boolean;
}

/** Picks what the desktop player bar's right side shows for the current player state. */
export const barTools = ({ status, mediaOnline, remote }: BarToolsInput): BarTools => {
  if (!mediaOnline && !remote) return "offline";

  if (status === "error") return "error";

  if (status === "buffering" || status === "loading") return "buffering";

  return "tools";
};
