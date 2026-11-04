import { NEXT_EPISODE_COUNTDOWN_MS } from "@media/contracts/clock";
import type { Episode } from "@media/contracts/models/catalog";

import { formatRuntime } from "../format";

/** The countdown before the next episode plays, and how often it ticks. */
export const NEXT_COUNTDOWN = { totalMs: NEXT_EPISODE_COUNTDOWN_MS, stepMs: 1_000 } as const;

const creditsSeconds = (durationSeconds: number): number => Math.min(30, durationSeconds * 0.1);

/** Where playback is, as the card reads it. */
export interface CreditsInput {
  readonly positionSeconds: number;
  readonly durationSeconds: number;
  readonly playing: boolean;
  readonly ended: boolean;
}

/** Whether playback is in the credits: playing near the end, or at the end. */
export const inCredits = ({
  positionSeconds,
  durationSeconds,
  playing,
  ended,
}: CreditsInput): boolean =>
  durationSeconds > 0 &&
  (ended || (playing && durationSeconds - positionSeconds <= creditsSeconds(durationSeconds)));

/** Whole seconds left on the countdown, rounded up: `Next Episode in 8s`. */
export const secondsLeft = (countdownMs: number): number =>
  Math.max(0, Math.ceil(countdownMs / 1000));

const seasonAndEpisode = (episode: Pick<Episode, "seasonNumber" | "episodeNumber">): string =>
  `S${String(episode.seasonNumber)}, E${String(episode.episodeNumber)}`;

/** An episode under its show's name, in the player and the watch room: `S1, E2 · Half Loop`. */
export const episodeLine = (
  episode: Pick<Episode, "seasonNumber" | "episodeNumber" | "name">,
): string => `${seasonAndEpisode(episode)} · ${episode.name}`;

/** The card's line under the episode name: `S2, E4 · 49m`. */
export const nextEpisodeFacts = (
  episode: Pick<Episode, "seasonNumber" | "episodeNumber" | "runtimeMs">,
): string => {
  const code = seasonAndEpisode(episode);

  return episode.runtimeMs === null || episode.runtimeMs <= 0
    ? code
    : `${code} · ${formatRuntime(episode.runtimeMs)}`;
};
