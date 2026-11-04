import type { EpisodeId } from "@media/contracts/ids";
import type { Episode } from "@media/contracts/models/catalog";
import type { Room } from "@media/contracts/models/rooms";

import type { RoomRole } from "./room-view";

/** The reason a card gives when the next episode has no file to play. */
export const FILE_MISSING = "File missing";

/** The next-episode card a member sees. */
export type RoomNextCard =
  | {
      readonly kind: "countdown";
      readonly episode: Episode;
      /** The server time the room moves on. */
      readonly nextAt: number;
      /** The host's card acts for everyone; a guest's only closes. */
      readonly role: RoomRole;
      /** Why the host's Play Next did not move the room on, shown in place of the countdown. */
      readonly problem: string | null;
    }
  | { readonly kind: "unavailable"; readonly episode: Episode; readonly reason: string };

/** Why the host's countdown could not start, for the episode it was meant to leave. */
export interface CountdownProblem {
  readonly from: EpisodeId;
  readonly reason: string;
}

/** What the card and the countdown's start read. */
export interface RoomNextInput {
  readonly role: RoomRole;
  /** The room's countdown for what it plays now. */
  readonly next: Room["next"];
  /** The episode the room plays. */
  readonly roomEpisodeId: EpisodeId | null;
  /** The episode this player plays. */
  readonly episodeId: EpisodeId | null;
  /** The episode after it, as the host's profile sees it; null after the last or while unknown. */
  readonly nextEpisode: Episode | null;
  /** The host's player is in the credits, playing or at the end. */
  readonly credits: boolean;
  /** The host may command the room now: connected, with the server clock known. */
  readonly canCommand: boolean;
}

/**
 * Whether the host's player should start the room's countdown now: in the credits of the episode
 * the room plays, with a next episode that can play and no countdown yet. The server keeps one
 * already running or cancelled, so starting again changes nothing.
 */
export const shouldStartCountdown = (input: RoomNextInput): boolean =>
  input.role === "host" &&
  input.credits &&
  input.canCommand &&
  input.next === null &&
  input.nextEpisode?.available === true &&
  input.episodeId !== null &&
  input.roomEpisodeId === input.episodeId;

/** The key a closed card is remembered by, so it stays closed for its countdown or episode. */
export const closedKey = (next: Room["next"], episodeId: EpisodeId | null): string =>
  next?.status === "pending" ? String(next.nextAt) : `unavailable:${String(episodeId)}`;

/**
 * The card to show, or null. Everyone sees a pending countdown until they close it, and the host
 * sees why its Play Next failed; only the host learns, in the credits, that the next episode cannot
 * play, since guests have no countdown to miss.
 */
export const roomNextCard = (
  input: RoomNextInput,
  closed: string | null,
  problem: CountdownProblem | null,
): RoomNextCard | null => {
  const { next, role, nextEpisode, episodeId } = input;

  if (next?.status === "pending") {
    return closed === String(next.nextAt)
      ? null
      : {
          kind: "countdown",
          episode: next.episode,
          nextAt: next.nextAt,
          role,
          problem: role === "host" && problem?.from === episodeId ? problem.reason : null,
        };
  }

  if (role !== "host" || !input.credits || nextEpisode === null || next !== null) return null;

  if (closed === closedKey(next, episodeId)) return null;

  const reason = !nextEpisode.available
    ? FILE_MISSING
    : problem?.from === episodeId
      ? problem.reason
      : null;

  return reason === null ? null : { kind: "unavailable", episode: nextEpisode, reason };
};
