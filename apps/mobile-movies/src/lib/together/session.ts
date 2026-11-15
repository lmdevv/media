/**
 * Movie group sessions as the iOS app reaches them over `core.together.*` (ADR 0017). A person
 * holds one place per domain, so every call names the movies domain and none a session.
 */
import type { SessionClock } from "@media/contracts/clock";
import type { Hold } from "@media/contracts/follower";
import { holdStands } from "@media/contracts/follower-policy";
import type { PlatformSdk } from "@media/sdk/promise";

import type { EpisodeId, TitleId } from "@/lib/catalog";

type Together = PlatformSdk["core"]["together"];

type Result<Method> = Method extends (...args: never) => Promise<infer A> ? A : never;

/** The domain every movies session call names. */
export const MOVIES = "movies" as const;

/** Where the person stands in their movies session, or null outside one. */
export type SessionView = Result<Together["get"]>;

/** A session the person is in, with its clock, members, and settings. */
export type JoinedSession = Extract<NonNullable<SessionView>, { readonly state: "joined" }>;

/** Someone waiting for the host to let them in; only the host sees them. */
export type WaitingPerson = NonNullable<JoinedSession["pending"]>[number];

/** Who may join, and what guests may do. */
export type SessionSettings = JoinedSession["settings"];

type DomainItem = NonNullable<JoinedSession["item"]>;

/** A movies item: a movie or show as a title, an episode, or a file. */
export type MoviesItem = Extract<DomainItem, { readonly domain: "movies" }>;

/** A queued entry as the viewer sees it: its item is null when they may not play it. */
export type QueueEntry = Result<Together["queue"]>["page"][number];

/** A playable target: a movie, or an episode of a show. */
export interface WatchTarget {
  readonly titleId: TitleId;
  readonly episodeId: EpisodeId | null;
}

/** The item a session plays or queues for `target`: the episode of a show, else the movie. */
export const itemOf = (target: WatchTarget): MoviesItem =>
  target.episodeId === null
    ? { domain: MOVIES, ref: { type: "title", id: target.titleId } }
    : { domain: MOVIES, ref: { type: "episode", id: target.episodeId } };

/** The movies item in `item`, or null for another domain's. */
export const moviesItem = (item: DomainItem | null): MoviesItem | null =>
  item?.domain === MOVIES ? item : null;

/** A stable key for an item, to compare two items. */
export const itemKey = (item: DomainItem): string =>
  `${item.domain}:${item.ref.type}:${item.ref.id}`;

/**
 * A stall hold kept by an owner that outlives the player, with the session it holds (ADR 0017). The
 * player screen keeps one across its playback attempts, each of which mounts a new follower, so the
 * next attempt's follower plays the session on once its player plays.
 */
export interface CarriedHold {
  readonly sessionId: string | null;
  readonly hold: Hold | null;
}

/** No hold, which an owner starts from. */
export const NO_HOLD: CarriedHold = { sessionId: null, hold: null };

/**
 * Whether `carried` holds `sessionId`, at `clock`, paused for this player's own stall: its pause is
 * on the way, or the hold still stands. A new attempt's player then starts playing rather than
 * paused, as the hold plays the session on only once it does.
 */
export const holdsSession = (
  carried: CarriedHold,
  sessionId: string,
  clock: SessionClock,
): boolean => {
  const { hold } = carried;

  if (carried.sessionId !== sessionId || hold === null) return false;

  return hold.kind === "pausing" || holdStands(hold.revision, clock);
};

/**
 * The web address of a session's join link, `<server>/movies/together#<link>`, as the web app
 * copies it; the link travels after `#`, so no request carries it.
 */
export const sessionUrl = (moviesUrl: string, link: string): string =>
  `${moviesUrl.replace(/\/+$/u, "")}/together#${link}`;

const LINK = /(mt_[A-Za-z0-9]+\.[A-Za-z0-9_-]+)\/?$/u;

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/**
 * The join link in `text`: the link itself (`mt_<session>.<secret>`), the web app's
 * `<server>/movies/together#<link>`, or this app's `movies://together/<link>`. Null for anything
 * else.
 */
export const parseSessionLink = (text: string): string | null =>
  LINK.exec(decoded(text.trim()))?.[1] ?? null;
