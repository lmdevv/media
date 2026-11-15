/**
 * Movie group sessions as the movies client reaches them over `core.together.*` (ADR 0017). A
 * person holds one place per domain, so every call names the movies domain and none a session.
 */
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

/** Someone in a session. */
export type SessionMember = JoinedSession["members"][number];

/** Someone waiting for the host to let them in; only the host sees them. */
export type WaitingPerson = NonNullable<JoinedSession["pending"]>[number];

/** Who may join, and what guests may do. */
export type SessionSettings = JoinedSession["settings"];

/** What a session plays or queues, of any domain. */
type DomainItem = NonNullable<JoinedSession["item"]>;

/** A movies item: a movie or show as a title, an episode, or a file. */
export type MoviesItem = Extract<DomainItem, { readonly domain: "movies" }>;

/** A queued entry as the viewer sees it: its item is null when they may not play it. */
export type QueueEntry = Result<Together["queue"]>["page"][number];

/** A playable target of the movies client: a movie, or an episode of a show. */
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

/** Whether `item` names `target`. */
export const namesTarget = (item: MoviesItem, target: WatchTarget): boolean =>
  itemKey(item) === itemKey(itemOf(target));

/**
 * The web address that opens a session's join link in the movies client: `/movies/together#<link>`.
 * The link travels after `#`, so no request or referrer carries it.
 */
export const sessionUrl = (link: string): string =>
  `${window.location.origin}${import.meta.env.BASE_URL}together#${link}`;

const LINK = /(mt_[A-Za-z0-9]+\.[A-Za-z0-9_-]+)\/?$/u;

/**
 * The join link in `text`: the link itself (`mt_<session>.<secret>`), or a web address ending in
 * it, such as `/movies/together#<link>` as the player copies it. Null for anything else.
 */
export const parseSessionLink = (text: string): string | null => {
  const trimmed = text.trim();
  const match = LINK.exec(decodeURIComponentSafe(trimmed));

  return match?.[1] ?? null;
};

const decodeURIComponentSafe = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};
