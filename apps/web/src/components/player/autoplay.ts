import { NEXT_EPISODE_COUNTDOWN_MS } from "@media/contracts/clock";

/**
 * The countdown before the next episode plays, and how often it ticks: as long alone as in a watch
 * room, where the server keeps it.
 */
export const AUTOPLAY_COUNTDOWN = { totalMs: NEXT_EPISODE_COUNTDOWN_MS, stepMs: 1_000 } as const;
