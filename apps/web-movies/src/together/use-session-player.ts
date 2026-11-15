import { positionAt, toServerTime } from "@media/contracts/clock";
import { sessionNext } from "@media/contracts/session-next";
import type { NextCountdown } from "@media/contracts/session-next";
import type { FollowerPlayer, ViewerMove } from "@media/contracts/follower";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { toastFailure } from "@media/ui/lib/failure";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { Episode } from "@/lib/catalog";
import { useLatest } from "@/lib/use-latest";

import { useCurrentSession, useServerNow } from "./current-session";
import { MOVIES, itemKey, itemOf, moviesItem, sessionUrl } from "./session";
import type {
  JoinedSession,
  MoviesItem,
  QueueEntry,
  SessionSettings,
  WaitingPerson,
  WatchTarget,
} from "./session";
import { useSessionFollower } from "./use-session-follower";
import type { Following } from "./use-session-follower";
import { useSessionTarget } from "./use-session-target";

/** How many queued entries the player reads: the panel's Up next shows these. */
const QUEUE_PAGE = 50;

/** How often the next-episode countdown and the host's steps are read again. */
const TICK_MS = 250;

/** How long a host's step that failed waits before it is tried again. */
const RETRY_MS = 2_000;

/** How a session the player followed stopped. */
type SessionStop =
  /** The host left or stayed away for good, so the session ended for everyone. */
  | { readonly kind: "ended"; readonly reason: "host-left" | "abandoned" }
  /** The host took the viewer out. */
  | { readonly kind: "removed" };

/** What the viewer can do about the session. */
interface SessionActions {
  /** Opens the start dialog and creates the session for what the page plays. */
  readonly start: () => void;
  /** Starts following the session the dialog created, from where the player stands. */
  readonly confirmStart: () => void;
  /** Closes the start dialog and ends the session it created. */
  readonly cancelStart: () => void;
  readonly copyLink: () => void;
  /** Leaves the session; for the host, ends it for everyone. */
  readonly leave: () => void;
  /** Goes on alone: after the session stopped, or leaving it while its host is away. */
  readonly goSolo: () => void;
  readonly configure: (settings: SessionSettings) => void;
  readonly admit: (userId: WaitingPerson["userId"]) => void;
  readonly turnAway: (userId: WaitingPerson["userId"]) => void;
  /** Plays `item` for everyone now: queued first, then skipped to. */
  readonly playNow: (item: MoviesItem) => void;
  /** Skips to what is queued first. */
  readonly playQueued: () => void;
  readonly removeEntry: (entryId: QueueEntry["entryId"]) => void;
}

/** Where a member's playback starts in the session. */
interface SessionStart {
  readonly positionMs: number;
  /** The session plays, so playback starts playing. */
  readonly play: boolean;
}

/** The player in its group session, or alone. */
export interface SessionPlayer {
  /**
   * `loading` while the person's session is read, so playback waits to know where to start;
   * `solo` outside a session, or in one that plays something else; `session` while following it.
   */
  readonly mode: "loading" | "solo" | "session";
  /** The session while following it. */
  readonly session: JoinedSession | null;
  /** Where playback starts in the session, read when the stream is ready. */
  readonly startAt: () => SessionStart;
  readonly hostName: string;
  readonly hosting: boolean;
  readonly mayControl: boolean;
  readonly mayAdd: boolean;
  /** The host is away, so the session waits for them. */
  readonly hostAway: boolean;
  /** How the followed session stopped, until the viewer goes on alone. */
  readonly stopped: SessionStop | null;
  /**
   * The start dialog's link: null while the session is created and reaches this screen, undefined
   * while the dialog is closed.
   */
  readonly starting: string | null | undefined;
  /** The person is in a session that plays something else, so this page cannot start one. */
  readonly elsewhere: boolean;
  /** The session's position now, by the server's clock as heartbeats estimate it. */
  readonly positionNow: () => number;
  readonly actions: SessionActions;
}

const copyText = async (text: string): Promise<void> => {
  await navigator.clipboard.writeText(text);
};

/**
 * The player's group session: whether the page follows it, and the session's commands. The page
 * follows the person's movies session when it plays the session's item; once following, it moves
 * with the session to whatever plays next. `player` is read only when an action needs where the
 * player stands.
 */
export const useSessionPlayer = (
  page: WatchTarget,
  player: { readonly current: FollowerPlayer | null },
): SessionPlayer => {
  const platform = usePlatform();
  const navigate = useNavigate();
  const view = useCurrentSession();
  const joined = view?.state === "joined" ? view : null;
  const target = useSessionTarget(moviesItem(joined?.item ?? null));
  const [following, setFollowing] = useState(false);
  /** The start dialog: open while not undefined, with the session it created once known. */
  const [created, setCreated] = useState<JoinedSession["sessionId"] | null | undefined>(undefined);
  const serverNow = useServerNow();
  const [stopped, setStopped] = useState<SessionStop | null>(null);
  const [left, setLeft] = useState<JoinedSession["sessionId"] | null>(null);

  const matches =
    target.status === "ready" &&
    target.target.titleId === page.titleId &&
    target.target.episodeId === page.episodeId;

  const mine = joined !== null && joined.sessionId !== left;
  const [lastHost, setLastHost] = useState("The host");

  // Kept past the session's end, whose view no longer names the host.
  if (joined !== null && joined.host !== lastHost) setLastHost(joined.host);

  if (!following && mine && matches && created === undefined && stopped === null) {
    setFollowing(true);
  }

  if (following && view !== undefined && !mine) {
    setFollowing(false);

    if (joined === null && view?.sessionId !== left) {
      setStopped(
        view?.state === "ended" ? { kind: "ended", reason: view.reason } : { kind: "removed" },
      );
    }
  }

  const session = following ? joined : null;

  // The session stopped under the player: hold it until the viewer chooses to go on alone.
  useEffect(() => {
    if (stopped !== null) player.current?.pause();
  }, [stopped, player]);
  const unavailable = following && target.status === "unavailable";
  const movedTo = following && target.status === "ready" && !matches ? target.target : null;

  useEffect(() => {
    if (movedTo === null) return;

    void navigate({
      to: "/watch/$titleId",
      params: { titleId: movedTo.titleId },
      search: movedTo.episodeId === null ? {} : { episodeId: movedTo.episodeId },
      replace: true,
    });
  }, [movedTo, navigate]);

  useEffect(() => {
    if (unavailable) void navigate({ to: "/together", replace: true });
  }, [unavailable, navigate]);

  const loading = view === undefined || (mine && target.status === "loading" && stopped === null);
  const latestSession = useLatest(session);
  const latestJoined = useLatest(joined);
  const latestCreated = useLatest(created);

  /** Seeks the session to where the player stands, then plays it; answers the newest revision. */
  const seekAndPlay = useCallback(
    async (revision: number, play: boolean): Promise<number> => {
      const positionMs = Math.max(0, player.current?.positionMs() ?? 0);

      const sought = await platform.core.together.control({
        domain: MOVIES,
        op: { kind: "seek", positionMs, revision },
      });

      if (!play) return sought.revision;

      const playing = await platform.core.together.control({
        domain: MOVIES,
        op: { kind: "play" },
      });

      return playing.revision;
    },
    [platform, player],
  );

  /** The new session's revision once its first seek answered, which Start seeks against. */
  const opening = useRef<Promise<number> | null>(null);

  /** Counts starts, so a start the viewer cancelled before it answered is undone, not applied. */
  const startCount = useRef(0);

  const start = useCallback((): void => {
    const attempt = ++startCount.current;

    setCreated(null);
    setStopped(null);

    void platform.core.together
      .create({ item: itemOf(page) })
      .then(async ({ sessionId }) => {
        const undo = async (): Promise<void> => {
          setLeft(sessionId);
          await platform.core.together.leave({ domain: MOVIES });
        };

        if (startCount.current !== attempt) return undo();

        opening.current = seekAndPlay(0, false);
        await opening.current;

        if (startCount.current !== attempt) return undo();

        setCreated(sessionId);

        return undefined;
      })
      .catch((cause: unknown) => {
        if (startCount.current !== attempt) return;

        setCreated(undefined);
        toastFailure(cause);
      });
  }, [platform, page, seekAndPlay]);

  const confirmStart = useCallback((): void => {
    const opened = latestJoined.current;

    if (opened === null || opened.sessionId !== latestCreated.current) return;

    void (opening.current ?? Promise.resolve(opened.clock.revision))
      .then((revision) =>
        seekAndPlay(
          Math.max(revision, opened.clock.revision),
          player.current?.isPaused() === false,
        ),
      )
      .catch(toastFailure)
      .finally(() => setCreated(undefined));
  }, [latestJoined, latestCreated, player, seekAndPlay]);

  const leave = useCallback((): void => {
    setLeft(latestJoined.current?.sessionId ?? null);
    setFollowing(false);
    void platform.core.together.leave({ domain: MOVIES }).catch(toastFailure);
  }, [platform, latestJoined]);

  const cancelStart = useCallback((): void => {
    const opened = latestCreated.current;

    startCount.current += 1;
    setCreated(undefined);

    if (opened === null || opened === undefined) return;

    setLeft(opened);
    setFollowing(false);
    void platform.core.together.leave({ domain: MOVIES }).catch(toastFailure);
  }, [latestCreated, platform]);

  const link = joined === null ? null : sessionUrl(joined.link);

  const copyLink = useCallback((): void => {
    if (link !== null) {
      void copyText(link).then(() => toast.success("Session link copied"), toastFailure);
    }
  }, [link]);

  const goSolo = useCallback((): void => {
    if (latestJoined.current !== null) leave();
    setStopped(null);
    void player.current?.play().catch(() => undefined);
  }, [latestJoined, leave, player]);

  const configure = useCallback(
    (settings: SessionSettings): void => {
      void platform.core.together.configure({ domain: MOVIES, ...settings }).catch(toastFailure);
    },
    [platform],
  );

  const admit = useCallback(
    (userId: WaitingPerson["userId"]): void => {
      void platform.core.together.admit({ domain: MOVIES, userId }).catch(toastFailure);
    },
    [platform],
  );

  const turnAway = useCallback(
    (userId: WaitingPerson["userId"]): void => {
      void platform.core.together.block({ domain: MOVIES, userId }).catch(toastFailure);
    },
    [platform],
  );

  const skipTo = useCallback(async (): Promise<void> => {
    await platform.core.together.control({
      domain: MOVIES,
      op: { kind: "next", revision: latestSession.current?.clock.revision ?? 0 },
    });
  }, [platform, latestSession]);

  const playNow = useCallback(
    (picked: MoviesItem): void => {
      void platform.core.together
        .add({ item: picked, at: "next" })
        .then(skipTo)
        .catch(toastFailure);
    },
    [platform, skipTo],
  );

  const playQueued = useCallback((): void => {
    void skipTo().catch(toastFailure);
  }, [skipTo]);

  const removeEntry = useCallback(
    (entryId: QueueEntry["entryId"]): void => {
      void platform.core.together.remove({ domain: MOVIES, entryId }).catch(toastFailure);
    },
    [platform],
  );

  const startAt = useCallback((): SessionStart => {
    const current = latestSession.current;

    if (current === null) return { positionMs: 0, play: true };

    return {
      positionMs: positionAt(current.clock, serverNow()),
      play: current.clock.status === "playing",
    };
  }, [latestSession, serverNow]);

  const positionNow = useCallback(
    (): number =>
      latestSession.current === null ? 0 : positionAt(latestSession.current.clock, serverNow()),
    [latestSession, serverNow],
  );

  const actions = useMemo(
    (): SessionActions => ({
      start,
      confirmStart,
      cancelStart,
      copyLink,
      leave,
      goSolo,
      configure,
      admit,
      turnAway,
      playNow,
      playQueued,
      removeEntry,
    }),
    [
      start,
      confirmStart,
      cancelStart,
      copyLink,
      leave,
      goSolo,
      configure,
      admit,
      turnAway,
      playNow,
      playQueued,
      removeEntry,
    ],
  );

  const host = session?.members.find((member) => member.role === "host");

  return {
    mode: loading ? "loading" : session === null ? "solo" : "session",
    session,
    startAt,
    hostName: joined?.host ?? lastHost,
    hosting: session?.role === "host",
    mayControl: session?.may.control === true,
    mayAdd: session?.may.add === true,
    hostAway: session !== null && host?.present !== true,
    stopped,
    starting:
      created === undefined
        ? undefined
        : joined !== null && joined.sessionId === created
          ? link
          : null,
    elsewhere: joined !== null && session === null,
    positionNow,
    actions,
  };
};

/** The next-episode card a member sees: the shared countdown, and the episode it moves on to. */
interface NextCard extends NextCountdown {
  readonly episode: Episode;
}

/** What the follow half reads from the player. */
export interface SessionFollowInput {
  /** The playback's player once it runs, or null. */
  readonly player: FollowerPlayer | null;
  /** The length of the playing media, or null while unknown. */
  readonly durationMs: number | null;
  /** The episode after the playing one, as the viewer sees it. */
  readonly nextEpisode: Episode | null;
}

/** The player following its session. */
export interface SessionFollow {
  readonly following: Following;
  /** Plays, pauses, or seeks for everyone; refused when the viewer may not control. */
  readonly move: (move: ViewerMove) => void;
  /** The next-episode card, or null. */
  readonly nextCard: NextCard | null;
  /** The first queued entries, as the viewer sees them. */
  readonly queue: ReadonlyArray<QueueEntry>;
  /** The host's Watch credits: takes the queued next episode out, for everyone. */
  readonly watchCredits: () => void;
}

const NO_ENTRIES: ReadonlyArray<QueueEntry> = [];

const IDLE_CLOCK = {
  status: "paused",
  positionAtAnchorMs: 0,
  anchorServerTime: 0,
  playbackRate: 1,
  revision: -1,
} as const;

/** The current time, refreshed every `intervalMs` while `enabled`. */
const useTicking = (enabled: boolean, intervalMs: number): number => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!enabled) return undefined;

    const timer = setInterval(() => setNow(Date.now()), intervalMs);

    return () => clearInterval(timer);
  }, [enabled, intervalMs]);

  return now;
};

/**
 * Follows `sessionPlayer`'s session with the player, and runs the end of each item: the shared
 * next-episode countdown, autoplay of what is queued, and the host's pause at the end of the last.
 */
export const useSessionFollow = (
  sessionPlayer: SessionPlayer,
  { player, durationMs, nextEpisode }: SessionFollowInput,
): SessionFollow => {
  const platform = usePlatform();
  const { session, hosting, mayControl } = sessionPlayer;
  const clock = session?.clock ?? null;
  const watched = useRef(new Set<string>());

  const followed = useSessionFollower({
    player: session === null ? null : player,
    sessionId: session?.sessionId ?? null,
    clock: clock ?? IDLE_CLOCK,
    durationMs,
    controls: mayControl,
    hosting,
  });

  const queue = usePlatformQuery(
    platform.core.together.queue,
    ...(session === null
      ? (["skip"] as const)
      : ([{ domain: MOVIES, paginationOpts: { numItems: QUEUE_PAGE, cursor: null } }] as const)),
  );

  const entries = queue.status === "success" ? queue.data.page : NO_ENTRIES;
  const offset = followed.state?.offset ?? null;
  const now = useTicking(session !== null, TICK_MS);
  const item = moviesItem(session?.item ?? null);

  const watchedKey =
    session === null || item === null ? null : `${session.sessionId}:${itemKey(item)}`;

  const playable = nextEpisode?.available === true ? nextEpisode : null;
  const head = entries[0] ?? null;

  const decided =
    session === null || clock === null || item === null
      ? null
      : sessionNext({
          clock,
          serverNow: offset === null ? null : toServerTime(now, offset),
          durationMs,
          nextKey:
            playable === null
              ? null
              : itemKey(itemOf({ titleId: playable.titleId, episodeId: playable.id })),
          headKey: head?.item === null || head === null ? null : itemKey(head.item),
          queued: head !== null,
          hosting,
          mayControl,
          creditsWatched: watchedKey !== null && watched.current.has(watchedKey),
        });

  const step = decided?.step ?? null;
  const counting = decided?.countdown !== null && decided?.countdown !== undefined;

  // Queued once per item, by whichever of the host's screens did it: any of them that sees the
  // countdown counts it as queued, so Watch credits on one stops it on all.
  useEffect(() => {
    if (hosting && counting && watchedKey !== null) watched.current.add(watchedKey);
  }, [hosting, counting, watchedKey]);

  const stepKey =
    step === null || clock === null || item === null
      ? null
      : `${watchedKey ?? ""}:${String(clock.revision)}:${step}:${head?.entryId ?? ""}`;

  const tried = useRef<string | null>(null);
  const [retries, setRetries] = useState(0);
  const latest = useLatest({ nextEpisode, clock, watchedKey });

  useEffect(() => {
    if (stepKey === null || step === null) return undefined;

    const attempt = `${stepKey}#${String(retries)}`;

    if (tried.current === attempt) return undefined;

    tried.current = attempt;

    const { nextEpisode: episode, clock: current, watchedKey: queuedFor } = latest.current;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let active = true;

    const run = async (): Promise<void> => {
      if (step === "queue") {
        if (episode !== null && current !== null) {
          // Against the clock it was decided on: the core queues the episode once across the
          // host's screens, and refuses an add that lands after the session moved on.
          await platform.core.together.add({
            item: itemOf({ titleId: episode.titleId, episodeId: episode.id }),
            at: "next",
            revision: current.revision,
          });
        }

        // Queued once per item: whoever takes it out stops the countdown for everyone.
        if (queuedFor !== null) watched.current.add(queuedFor);

        return;
      }

      if (step === "next") {
        if (current !== null) {
          await platform.core.together.control({
            domain: MOVIES,
            op: { kind: "next", revision: current.revision },
          });
        }

        return;
      }

      // Against the clock it was decided on, as no one asked for it: a play or seek someone made
      // at the end since, which this screen may not have heard of yet, stands.
      if (current !== null) {
        await platform.core.together.control({
          domain: MOVIES,
          op: { kind: "pause", revision: current.revision },
        });
      }
    };

    void run().catch(() => {
      if (active) retry = setTimeout(() => setRetries((count) => count + 1), RETRY_MS);
    });

    return () => {
      active = false;
      clearTimeout(retry);
    };
  }, [stepKey, step, retries, platform, latest]);

  const latestSession = useLatest(session);
  const followMove = followed.move;

  const move = useCallback(
    (next: ViewerMove): void => {
      const current = latestSession.current;

      if (current === null) return;

      if (!current.may.control) {
        toast(`Only ${current.host} can pause or seek`);

        return;
      }

      void followMove(next).then((refused) => {
        if (refused !== null) toast.error(refused.message);

        return undefined;
      });
    },
    [latestSession, followMove],
  );

  const latestEntries = useLatest(entries);
  const latestWatched = useLatest(watchedKey);

  const watchCredits = useCallback((): void => {
    const key = latestWatched.current;
    const first = latestEntries.current[0];

    if (key === null) return;

    watched.current.add(key);

    if (first !== undefined) {
      void platform.core.together
        .remove({ domain: MOVIES, entryId: first.entryId })
        .catch(toastFailure);
    }
  }, [latestWatched, latestEntries, platform]);

  return {
    following: followed,
    move,
    nextCard:
      decided?.countdown === null || decided === null || playable === null
        ? null
        : { ...decided.countdown, episode: playable },
    queue: entries,
    watchCredits,
  };
};
