import type { ContentDomain } from "../../../commands/scopes";
import type { Doc, Id } from "../../_generated/dataModel";
import { fail } from "../lib/errors";

/** What a device last said it plays (ADR 0018). */
export type Player = Doc<"connectPlayers">;

/** The playback controllers last asked of a device. */
export type Request = Doc<"connectRequests">;

/** A device that has not reported for this long is offline, and a command to it fails. */
export const ONLINE_MS = 30_000;

/** Whether the device reported within `ONLINE_MS` of `now`. */
export const isOnline = (player: Player, now: number): boolean =>
  now - player.reportedAt <= ONLINE_MS;

/** Play or pause at a position in server time: `positionMs` held at `at`. */
export interface Transport {
  readonly playing: boolean;
  readonly positionMs: number;
  readonly at: number;
}

/** What a device plays as controllers see it: `pending` while it has a request to apply. */
export interface Playback extends Transport {
  readonly domain: ContentDomain;
  readonly pending: boolean;
}

/** What a controller asks a device for: play or pause, a position, or both. */
export interface Change {
  readonly playing?: boolean | undefined;
  readonly positionMs?: number | undefined;
}

/** The request a device's reporter has not settled yet, or null. */
export const pendingRequest = (player: Player, request: Request | null): Request | null =>
  request !== null && request.reporter === player.reporter && request.revision > player.settled
    ? request
    : null;

/** What a device plays, with the request it has yet to apply standing in for its report. */
export const playbackOf = (player: Player, request: Request | null): Playback | null => {
  if (player.playback === null) return null;

  const { domain } = player.playback;
  const pending = pendingRequest(player, request);

  return pending === null
    ? {
        domain,
        playing: player.playback.playing,
        positionMs: player.playback.positionMs,
        at: player.reportedAt,
        pending: false,
      }
    : {
        domain,
        playing: pending.playing,
        positionMs: pending.positionMs,
        at: pending.at,
        pending: true,
      };
};

/** Where `transport` is at server time `now`. */
export const positionAt = (transport: Transport, now: number): number =>
  transport.playing ? transport.positionMs + Math.max(0, now - transport.at) : transport.positionMs;

/** The transport `change` makes of `current` at `now`; what it leaves out stays as it is. */
export const changed = (current: Transport, change: Change, now: number): Transport => ({
  playing: change.playing ?? current.playing,
  positionMs: change.positionMs ?? positionAt(current, now),
  at: now,
});

/** The next request's revision on a device, above every request before it. */
export const nextRevision = (request: Request | null): number => (request?.revision ?? 0) + 1;

/** The revision a report leaves settled. It never goes down for the same reporter. */
export const settledAfter = (
  stored: Player | null,
  reporter: Id<"authSessions">,
  applied: number,
  newestRevision: number,
): number =>
  stored !== null && stored.reporter === reporter
    ? Math.max(stored.settled, applied)
    : newestRevision;

/** A position as a command or a report gives it: a finite number of milliseconds, 0 or more. */
export const parsePosition = (positionMs: number): number =>
  Number.isFinite(positionMs) && positionMs >= 0
    ? positionMs
    : fail("invalid_args", "A position is a number of milliseconds, 0 or more");
