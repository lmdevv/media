/**
 * The person's music group session on the web and on iOS (ADR 0017), as the player plays it and
 * the music clients' screens show it: one subscription to `core.together.get` and every page of
 * the session's queue, read once for every screen. Each page carries its songs' details; the song
 * playing, and the song queued first, which plays next, are read on their own besides.
 */
import type { FollowerState } from "@media/contracts/follower";
import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatformQuery } from "@media/sdk/react";
import type { QueryState } from "@media/sdk/react";
import { Brand, Match } from "effect";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { NO_CONTROL, playingKey } from "./session-playback";
import type {
  QueueListing,
  SessionControl,
  SessionFollow,
  SessionOp,
  SessionPlayback,
  SessionSong,
  StartCommands,
} from "./session-playback";
import { TrackShelf } from "./track-shelf";

type Together = PlatformSdk["core"]["together"];

type Answer<Method> = Method extends (...args: never) => Promise<infer Result> ? Result : never;

type Track = Answer<PlatformSdk["music"]["tracks"]["get"]>;

/** The domain every music session call names. */
export const MUSIC = "music" as const;

/** Where the person stands in their music session: joined, waiting, ended, or in none (null). */
export type SessionView = Answer<Together["get"]>;

/** A session the person is in, with its clock, members, and settings. */
export type JoinedSession = Extract<NonNullable<SessionView>, { readonly state: "joined" }>;

/** Who may join a session, and what its guests may do. */
export type SessionSettings = JoinedSession["settings"];

/** Someone in a session. */
export type SessionMember = JoinedSession["members"][number];

/** Someone waiting for the host to let them in; only the host sees them. */
export type WaitingPerson = NonNullable<JoinedSession["pending"]>[number];

type QueuePage = Answer<Together["queue"]>;

type QueueRow = QueuePage["page"][number];

/** One entry of the session's queue as this person sees it. */
export interface SessionEntry {
  /** The entry's id, which the core takes it out or moves it by. */
  readonly key: QueueRow["entryId"];
  /** Its song; null while its details load, or when it is hidden. */
  readonly track: Track | null;
  /** This person may not play it, as a kid an explicit song: it shows as hidden. */
  readonly hidden: boolean;
  /** Who queued it, by the name they go by or else their username; null for someone who left. */
  readonly addedBy: string | null;
  /** This person may take it out and move it: the host any entry, a guest their own. */
  readonly removable: boolean;
}

/** Someone a session's screens name: by the name they go by, or their username without one. */
export const shownName = (person: {
  readonly username: string;
  readonly displayName: string | null;
}): string => person.displayName ?? person.username;

/**
 * Someone a host acts on, as to let in or remove: the name they go by and their username, which
 * no one else has, since two people may go by one name.
 */
export const fullName = (person: {
  readonly username: string;
  readonly displayName: string | null;
}): string =>
  person.displayName === null ? person.username : `${person.displayName} (${person.username})`;

/** The name a session's host shows by, as `shownName` names everyone. */
export const hostName = (view: {
  readonly host: string;
  readonly hostDisplayName: string | null;
}): string => view.hostDisplayName ?? view.host;

/** What the core answers of the person's music session, with the details of its songs. */
export interface SessionData {
  /** Where they stand, or null in none; undefined while it loads. */
  readonly view: SessionView | undefined;
  /** The song the session plays, as this person sees it: null while loading or when hidden. */
  readonly playing: Track | null;
  /** The playing song is one this person may not play. */
  readonly playingHidden: boolean;
  /** The session's queue in play order, as its last whole listing lists it; none until one. */
  readonly entries: ReadonlyArray<SessionEntry>;
  /** Whether anything is queued, shown or not, as far as the queue is listed. */
  readonly listing: QueueListing;
}

/** The person's music session for the screens, once read. */
export interface MusicSession extends SessionData {
  /** How this person's player follows, or null while none does. */
  readonly following: FollowerState | null;
  /** A session is starting from this player. */
  readonly starting: boolean;
  /**
   * Starts a session on the song this player plays, where it stands, with the songs queued after it
   * queued in the session, as old music's jams shared the host's player and queue. Resolves with
   * its join link; rejects with the core's refusal.
   */
  readonly start: () => Promise<string>;
}

/** Queue entries asked for per page; the core caps a page to what one call may decide. */
const QUEUE_PAGE = 200;

/** How long the queue's pages wait before they are followed again after one failed. */
const QUEUE_RESTART_MS = 250;

/** Where a page of the queue starts, and where it ends once the page after it is loaded. */
interface PageSpan {
  readonly cursor: string | null;
  readonly endCursor?: string;
}

/** A followed query, as the SDK's `watch` and the paged store's pages are. */
interface Watch<A> {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => QueryState<A>;
}

/** What follows the queue's pages loaded so far. */
type NextPage =
  | { readonly kind: "done" }
  | { readonly kind: "more"; readonly load: () => void }
  | { readonly kind: "loading" }
  | { readonly kind: "failed" };

/** The queue's pages as the paged store folds them, first to last. */
type QueuePages =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | {
      readonly status: "ready";
      readonly rows: ReadonlyArray<QueueRow>;
      readonly next: NextPage;
    };

/** A store over the queue's pages, as the paged store makes one. */
interface PagesStore {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => QueuePages;
}

/**
 * The client's paged store, as `useQueueListing` takes it: `pagedStore` from `@media/ui/lib/pages`
 * on the web, or from `@media/mobile-core/pages` on iOS, which can't import `@media/ui`.
 */
export type SessionPagedStore = (pageAt: (span: PageSpan) => Watch<QueuePage>) => PagesStore;

const LOADING: QueuePages = { status: "loading" };

/** No pages, outside a joined session. */
const NO_PAGES: PagesStore = {
  subscribe: () => () => undefined,
  getSnapshot: () => LOADING,
};

const queuePages = (platform: PlatformSdk, pagedStore: SessionPagedStore): PagesStore =>
  pagedStore((span) =>
    platform.core.together.queue.watch({
      domain: MUSIC,
      paginationOpts: { numItems: QUEUE_PAGE, ...span },
    }),
  );

/** The pages a session's queue is followed through, and the session whose queue they list. */
interface Followed {
  readonly sessionId: string;
  readonly store: PagesStore;
}

/** The last whole listing of a session's queue, and the session it lists. */
interface Whole {
  readonly sessionId: string;
  readonly rows: ReadonlyArray<QueueRow>;
}

/**
 * A session's queue as its pages list it: not whole yet, or whole, now or the last time the pages
 * were (`useSessionQueue`).
 */
type QueueRows =
  | { readonly whole: "not-yet" }
  | { readonly whole: "now" | "before"; readonly rows: ReadonlyArray<QueueRow> };

const NOT_YET: QueueRows = { whole: "not-yet" };

/**
 * Every entry of the queue of the person's session `sessionId`, followed live, loading the next
 * page as soon as one arrives, as `useQueueListing` follows the listener's own queue; not whole
 * outside a joined session and until every page first arrived. A session the person joins, or
 * joins again, starts pages of its own. The last whole listing stays while the pages load again,
 * as when a page grew past what one call may read and splits, or one failed, as one whose cursor
 * Convex refuses, which starts the pages over: the player never loses what plays next.
 */
const useSessionQueue = (
  platform: PlatformSdk,
  pagedStore: SessionPagedStore,
  sessionId: string | null,
): QueueRows => {
  const [followed, setFollowed] = useState<Followed | null>(null);
  const [last, setLast] = useState<Whole | null>(null);

  if ((followed?.sessionId ?? null) !== sessionId) {
    setFollowed(sessionId === null ? null : { sessionId, store: queuePages(platform, pagedStore) });
    setLast(null);
  }

  const store = followed !== null && followed.sessionId === sessionId ? followed.store : NO_PAGES;
  const paged = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const load = paged.status === "ready" && paged.next.kind === "more" ? paged.next.load : null;
  const whole = paged.status === "ready" && paged.next.kind === "done" ? paged.rows : null;

  const failed =
    paged.status === "failed" || (paged.status === "ready" && paged.next.kind === "failed");

  if (whole !== null && sessionId !== null && last?.rows !== whole) {
    setLast({ sessionId, rows: whole });
  }

  useEffect(() => {
    load?.();
  }, [load]);

  useEffect(() => {
    if (!failed || followed === null) return undefined;

    const timer = setTimeout(() => {
      setFollowed({ sessionId: followed.sessionId, store: queuePages(platform, pagedStore) });
    }, QUEUE_RESTART_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [failed, followed, platform, pagedStore]);

  return useMemo((): QueueRows => {
    if (whole !== null) return { whole: "now", rows: whole };

    return last !== null && last.sessionId === sessionId
      ? { whole: "before", rows: last.rows }
      : NOT_YET;
  }, [whole, last, sessionId]);
};

/**
 * What `rows`, the entries of `listed`, say is queued: entries; nothing, only when the pages list
 * the whole queue now; and otherwise not known yet. A last listing that had nothing may be behind
 * an add made while the pages load again.
 */
const listingOf = (listed: QueueRows, rows: ReadonlyArray<QueueRow>): QueueListing => {
  if (listed.whole === "not-yet") return "loading";

  if (rows.length > 0) return "listed";

  return listed.whole === "now" ? "empty" : "loading";
};

const songOf = (item: JoinedSession["item"] | QueueRow["item"]): string | null =>
  item?.domain === MUSIC && item.ref.type === "track" ? item.ref.id : null;

/**
 * Reads the person's music session and every entry of its queue, with the details of its songs,
 * for the player and the screens.
 *
 * @param pagedStore - The client's paged store.
 */
export const useSessionData = (
  platform: PlatformSdk,
  pagedStore: SessionPagedStore,
): SessionData => {
  const got = usePlatformQuery(platform.core.together.get, { domain: MUSIC });

  // A session that cannot be read plays as none, so the listener's own queue plays.
  const view = Match.value(got).pipe(
    Match.when({ status: "success" }, (state): SessionView | undefined => state.data),
    Match.when({ status: "error" }, () => null),
    Match.orElse(() => undefined),
  );

  const joined = view?.state === "joined" ? view : null;
  const listed = useSessionQueue(platform, pagedStore, joined?.sessionId ?? null);

  const [shelf] = useState(
    () =>
      new TrackShelf<Track>((trackId) =>
        platform.music.tracks.get.watch({ trackId: asTrackId(trackId) }),
      ),
  );

  const playingId = joined === null ? null : songOf(joined.item);

  // Each entry once, by its id, should a row show on two pages for a moment as they move.
  const queued = useMemo((): ReadonlyArray<QueueRow> => {
    const seen = new Set<string>();
    const rows = listed.whole === "not-yet" ? [] : listed.rows;

    return rows.filter((row) => {
      if (seen.has(row.entryId)) return false;

      seen.add(row.entryId);

      return true;
    });
  }, [listed]);

  // The song playing, which no page holds, and the one queued first, so its details are in hand
  // the moment the session moves on to it and its entry leaves the pages.
  const nextId = queued[0] === undefined ? null : songOf(queued[0].item);

  const wanted = useMemo(
    () => [playingId, nextId].filter((id): id is string => id !== null),
    [playingId, nextId],
  );

  useEffect(() => {
    shelf.want(wanted);
  }, [shelf, wanted]);

  useEffect(() => () => shelf.clear(), [shelf]);

  const songs = useSyncExternalStore(shelf.subscribe, shelf.getSnapshot, shelf.getSnapshot);

  const entries = useMemo(
    (): ReadonlyArray<SessionEntry> =>
      queued.map((row) => ({
        key: row.entryId,
        track: row.track,
        hidden: songOf(row.item) === null,
        addedBy: row.addedByDisplayName ?? row.addedBy,
        removable: row.removable,
      })),
    [queued],
  );

  const playing = playingId === null ? null : (songs.get(playingId) ?? null);
  const playingHidden = joined !== null && playingId === null;
  const listing = listingOf(listed, queued);

  // One object while nothing changed, so the player follows the session only when it changes.
  return useMemo(
    (): SessionData => ({ view, playing, playingHidden, entries, listing }),
    [view, playing, playingHidden, entries, listing],
  );
};

/**
 * The session as the player follows it, or null outside a joined session. A playing song whose
 * details still load, or that is hidden, follows as no song: nothing plays for this person until
 * its details are in, if ever.
 */
export const followOf = (data: SessionData): SessionFollow<Track> | null => {
  const { view } = data;

  if (view?.state !== "joined") return null;

  const song = (key: string, track: Track | null): SessionSong<Track> => ({ key, track });

  return {
    sessionId: view.sessionId,
    hosting: view.role === "host",
    mayControl: view.may.control,
    clock: view.clock,
    playing: song(playingKey(view.sessionId, view.entryId), data.playing),
    queued: data.entries.map((entry) => song(entry.key, entry.track)),
    listing: data.listing,
  };
};

const MusicSessionContext = createContext<MusicSession | null>(null);

/** Provides `useMusicSession` with what the player read. */
export const MusicSessionProvider = MusicSessionContext.Provider;

/** The person's music session for the screens. Must be inside the music `PlayerProvider`. */
export const useMusicSession = (): MusicSession => {
  const session = useContext(MusicSessionContext);

  if (session === null) throw new Error("useMusicSession must be used inside PlayerProvider");

  return session;
};

/** Song ids the core answered in the session's item and queue. */
const asTrackId = Brand.nominal<Track["id"]>();

type ControlArg = Parameters<Together["control"]>[0]["op"];

type SessionEntryId = NonNullable<Extract<ControlArg, { readonly kind: "next" }>["entryId"]>;

/** Session entry ids the player hands back, which the core answered in the session's queue. */
export const asEntryId = Brand.nominal<SessionEntryId>();

/** Session ids the player hands back, which the core answered in `core.together.get`. */
const asSessionId = Brand.nominal<JoinedSession["sessionId"]>();

/** A music song as the core's session calls name it. */
export const musicTrack = (id: Track["id"]) =>
  ({ domain: MUSIC, ref: { type: "track", id } }) as const;

/** A session move as `core.together.control` takes it, without fields left out. */
export const controlOp = (op: SessionOp): ControlArg => {
  if (op.kind === "next") {
    return op.entryId === undefined
      ? { kind: "next", revision: op.revision }
      : { kind: "next", revision: op.revision, entryId: asEntryId(op.entryId) };
  }

  if (op.kind === "seek") return op;

  return op.revision === undefined ? { kind: op.kind } : { kind: op.kind, revision: op.revision };
};

/** `core.together.control` in music, for the session each move names, as the player calls it. */
export const sessionControl =
  (platform: PlatformSdk): SessionControl =>
  (op, sessionId) =>
    platform.core.together.control({
      domain: MUSIC,
      op: controlOp(op),
      sessionId: asSessionId(sessionId),
    });

/** The core's calls that start a music session from the listener's song and queue. */
export const startCommands = (platform: PlatformSdk): StartCommands => ({
  create: async (trackId) =>
    platform.core.together.create({ item: musicTrack(asTrackId(trackId)) }),
  control: sessionControl(platform),
  addItems: async (sessionId, trackIds) =>
    (
      await platform.core.together.addItems({
        domain: MUSIC,
        sessionId: asSessionId(sessionId),
        items: trackIds.map((id) => musicTrack(asTrackId(id))),
      })
    ).taken,
});

/** Old music's words for a member who may not add to the session. */
export const NO_ADDS = "The host turned off adding songs in this Jam";

/** The most songs one play in a session queues, as a long playlist would flood it. */
const SESSION_PLAY_MAX = 100;

/**
 * Queues `trackIds` in the person's session in order, in front of what is queued or after it, a
 * call at a time: in front, the last goes first. Each add names the session `view` shows, so the
 * core refuses the rest once the person left it, rather than queue them in another. Rejects with
 * old music's words when the host does not take songs, or with the core's refusal, which stops
 * the rest.
 */
export const addToSession = async (
  platform: PlatformSdk,
  view: JoinedSession,
  trackIds: ReadonlyArray<Track["id"]>,
  next: boolean,
): Promise<void> => {
  if (!view.may.add) throw new Error(NO_ADDS);

  const ordered = next ? trackIds.toReversed() : trackIds;

  await ordered.reduce(
    (done: Promise<unknown>, id) =>
      done.then(() =>
        platform.core.together.add({
          item: musicTrack(id),
          at: next ? "next" : "end",
          sessionId: view.sessionId,
        }),
      ),
    Promise.resolve(),
  );
};

/**
 * Plays `trackIds` from `index` now for everyone, as old music's host played a list in a Jam: the
 * first goes in front of the queue and the session skips to that entry at once, playing it in a
 * session that was paused, then the rest follow it in order, up to 100 songs. Resolves with why
 * the session refused, for the screen, or null; rejects when an add fails.
 */
export const playInSession = async (
  platform: PlatformSdk,
  view: JoinedSession,
  playback: Pick<SessionPlayback, "jump" | "play">,
  trackIds: ReadonlyArray<Track["id"]>,
  index = 0,
): Promise<string | null> => {
  if (!view.may.control) return NO_CONTROL;

  if (!view.may.add) return NO_ADDS;

  const [first, ...rest] = trackIds.slice(index, index + SESSION_PLAY_MAX);

  if (first === undefined) return null;

  const { entryId } = await platform.core.together.add({
    item: musicTrack(first),
    at: "next",
    sessionId: view.sessionId,
  });

  const refused = await playback.jump(entryId);

  if (refused !== null) return refused;

  // A skip keeps the clock playing or paused; playing a song now plays it.
  const unplayed = view.clock.status === "paused" ? await playback.play() : null;

  if (unplayed !== null) return unplayed;

  await addToSession(platform, view, rest, true);

  return null;
};
