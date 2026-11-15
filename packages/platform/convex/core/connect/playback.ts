import type { DomainItem } from "../../../commands/access";
import type { Doc, Id } from "../../_generated/dataModel";
import { fail } from "../lib/errors";
import type { Ask, Reported } from "./model";

/** What a device last said it plays (ADR 0018). */
export type Player = Doc<"connectPlayers">;

/** The playback controllers last asked of a device. */
export type Request = Doc<"connectRequests">;

/** A request with an ask, the shape every request since items has. */
export type Asked = Extract<Request, { readonly ask: Ask }>;

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

/**
 * What a device plays as controllers see it: `pending` while a request it has yet to apply stands
 * in for its report, and `loading` while that request is a load, as the revision that first asked
 * for that load.
 */
export interface Playback extends Transport {
  readonly item: DomainItem;
  readonly pending: boolean;
  readonly loading: number | null;
}

/** What a controller asks a device for: play or pause, a position, or both. */
export interface Change {
  readonly playing?: boolean | undefined;
  readonly positionMs?: number | undefined;
}

const sameItem = (left: DomainItem, right: DomainItem): boolean =>
  left.domain === right.domain && left.ref.type === right.ref.type && left.ref.id === right.ref.id;

/**
 * What the device's report says it plays, or null. A report from before items (v0.3.0) names no
 * item, so it reads as playing nothing until the device reports again.
 */
export const reportOf = (player: Player): Reported | null =>
  player.playback !== null && "item" in player.playback ? player.playback : null;

/**
 * The request a device's reporter has not settled yet, or null. A request from before items
 * (v0.3.0) names no item, so it is never pending.
 */
export const pendingRequest = (player: Player, request: Request | null): Asked | null =>
  request !== null &&
  "ask" in request &&
  request.reporter === player.reporter &&
  request.revision > player.settled
    ? request
    : null;

const reportedOf = (player: Player): Playback | null => {
  const reported = reportOf(player);

  return reported === null
    ? null
    : {
        item: reported.item,
        playing: reported.playing,
        positionMs: reported.positionMs,
        at: player.reportedAt,
        pending: false,
        loading: null,
      };
};

const askedOf = (ask: Exclude<Ask, { readonly kind: "stop" }>): Playback => ({
  item: ask.item,
  playing: ask.playing,
  positionMs: ask.positionMs,
  at: ask.at,
  pending: true,
  loading: ask.kind === "load" ? ask.loadRevision : null,
});

/** What a device plays, with the request it has yet to apply standing in for its report. */
export const playbackOf = (player: Player, request: Request | null): Playback | null => {
  const reported = reportedOf(player);
  const ask = pendingRequest(player, request)?.ask ?? null;

  if (ask === null) return reported;

  if (ask.kind === "stop") return null;

  if (ask.kind === "load") return askedOf(ask);

  return reported !== null && sameItem(reported.item, ask.item) ? askedOf(ask) : reported;
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

/**
 * What `control` asks of a device playing `current`. A pending load stays that load, under the
 * revision that first asked for it: a device that already started it, such as an album's first
 * song, only plays, pauses, or seeks, and one that has not starts it with the change.
 */
export const controlAsk = (current: Playback, change: Change, now: number): Ask => {
  const transport = changed(current, change, now);

  return current.loading === null
    ? { kind: "transport", item: current.item, ...transport }
    : { kind: "load", item: current.item, ...transport, loadRevision: current.loading };
};

/** What `load` asks of a device under `revision`: `item` from `positionMs`, playing. */
export const loadAsk = (
  item: DomainItem,
  positionMs: number,
  now: number,
  revision: number,
): Ask => ({ kind: "load", item, playing: true, positionMs, at: now, loadRevision: revision });

/** What `move` asks under `revision` of the device that receives playback. */
export const moveAsk = (current: Playback, now: number, revision: number): Ask => ({
  kind: "load",
  item: current.item,
  playing: current.playing,
  positionMs: positionAt(current, now),
  at: now,
  loadRevision: revision,
});

/** The next request's revision on a device, above every request before it. */
export const nextRevision = (request: Request | null): number => (request?.revision ?? 0) + 1;

/**
 * The revision a report leaves settled. It never goes down for a reporter that stayed online; a new
 * reporter, or one back from offline, settles every request before it.
 */
export const settledAfter = (
  stored: Player | null,
  reporter: Id<"authSessions">,
  applied: number,
  newestRevision: number,
  now: number,
): number =>
  stored !== null && stored.reporter === reporter && isOnline(stored, now)
    ? Math.max(stored.settled, applied)
    : newestRevision;

/** A position as a command or a report gives it: a finite number of milliseconds, 0 or more. */
export const parsePosition = (positionMs: number): number =>
  Number.isFinite(positionMs) && positionMs >= 0
    ? positionMs
    : fail("invalid_args", "A position is a number of milliseconds, 0 or more");
