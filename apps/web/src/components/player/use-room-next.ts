import type { DeviceId, EpisodeId, RoomId, TitleId } from "@media/contracts/ids";
import type { Episode } from "@media/contracts/models/catalog";
import type { Room } from "@media/contracts/models/rooms";
import { useCommand } from "@media/sdk/react";
import { useNavigate } from "@tanstack/react-router";
import { Predicate } from "effect";
import { useCallback, useEffect, useState } from "react";

import { returnTarget } from "@/lib/current-room";
import { describeFailure } from "@/lib/failure";
import { useLatest } from "@/lib/use-latest";

/** What the hook needs from the player. */
export interface RoomNextInput {
  /** The room the player is in, once joined; null outside rooms. */
  readonly room: Room | null;
  readonly deviceId: DeviceId;
  /** This device's part in the room; null outside rooms. */
  readonly role: "host" | "guest" | null;
  /** What the page opened, which the room's media is compared with. */
  readonly page: { readonly titleId: TitleId; readonly episodeId: EpisodeId | undefined };
  /** The episode this player plays, which the host's Play next moves on from. */
  readonly episodeId: EpisodeId | null;
  /** The episode after it, as the host's profile sees it; null after the last or while unknown. */
  readonly nextEpisode: Episode | null;
  /**
   * Whether the host's player is in the credits and playing (or at the end), so the countdown
   * starts, as solo autoplay would start its own.
   */
  readonly credits: boolean;
  /** Whether the host may command the room now: connected, with the server clock known. */
  readonly canCommand: boolean;
}

/** The next-episode card a member sees. */
export type RoomNextCard =
  | {
      readonly kind: "countdown";
      readonly episode: Episode;
      /** The server time the room moves on. */
      readonly nextAt: number;
      /** The host's card acts for everyone; a guest's only closes. */
      readonly role: "host" | "guest";
    }
  | { readonly kind: "unavailable"; readonly episode: Episode; readonly reason: string };

/** The room's next episode for the player. */
export interface RoomNext {
  /** The card to show, or null. */
  readonly card: RoomNextCard | null;
  /**
   * Moves the room on now: the host's Play next, Next button, ⌘K command, and media-session next.
   * Null for guests, after the last episode, and when the next one cannot play.
   */
  readonly playNext: (() => void) | null;
  /** The host's Play next on the card, moving the room on to the episode it counts down to. */
  readonly moveOn: () => void;
  /** The host's Watch credits: cancels the countdown for everyone. */
  readonly cancel: () => void;
  /** Closes the card on this screen only: a guest's Close, or the host's on an unavailable card. */
  readonly close: () => void;
  /** Moves the room to another episode of its show: the host's Episodes picker. Null for guests. */
  readonly pick: ((episodeId: EpisodeId) => void) | null;
}

const FILE_MISSING = "File missing";

const REFUSALS = ["Conflict", "NotFound", "Forbidden", "InvalidArgs"] as const;

const RETRY_MS = 2_000;

/**
 * The room's next episode for the player. Outside rooms it does nothing and offers nothing, so
 * solo playback keeps its own countdown.
 */
export const useRoomNext = ({
  room,
  deviceId,
  role,
  page,
  episodeId,
  nextEpisode,
  credits,
  canCommand,
}: RoomNextInput): RoomNext => {
  const navigate = useNavigate();
  const startCountdown = useCommand("rooms.startNextCountdown");
  const cancelCountdown = useCommand("rooms.cancelNextCountdown");
  const moveOn = useCommand("rooms.playNext");
  const setMedia = useCommand("rooms.setMedia");
  const readRoom = useCommand("rooms.get");
  const latestRoom = useLatest(room);
  const roomId: RoomId | null = room?.id ?? null;
  const next = room?.next ?? null;
  const [problem, setProblem] = useState<{ readonly from: EpisodeId; readonly reason: string }>();
  const [attempt, setAttempt] = useState(0);
  const [closed, setClosed] = useState<string | null>(null);

  const hosting = role === "host" && roomId !== null;
  const nextPlays = nextEpisode?.available === true;

  const shouldStart =
    hosting &&
    credits &&
    canCommand &&
    next === null &&
    nextPlays &&
    episodeId !== null &&
    room?.episode?.id === episodeId;

  useEffect(() => {
    if (!shouldStart) return undefined;

    let retry: ReturnType<typeof setTimeout> | undefined;
    let active = true;

    startCountdown({ roomId, deviceId, fromEpisodeId: episodeId }).catch((cause: unknown) => {
      if (!active) return;

      if (REFUSALS.some((tag) => Predicate.isTagged(cause, tag))) {
        setProblem({ from: episodeId, reason: describeFailure(cause) });

        return;
      }

      retry = setTimeout(() => setAttempt((count) => count + 1), RETRY_MS);
    });

    return () => {
      active = false;
      clearTimeout(retry);
    };
  }, [shouldStart, roomId, episodeId, deviceId, startCountdown, attempt]);

  const roomTitle = room?.title.id ?? null;
  const roomEpisode = room?.episode?.id;

  useEffect(() => {
    if (roomId === null || roomTitle === null) return;

    if (roomTitle === page.titleId && roomEpisode === page.episodeId) return;

    void navigate({
      ...returnTarget({ id: roomId, titleId: roomTitle, episodeId: roomEpisode ?? null }),
      replace: true,
    });
  }, [roomId, roomTitle, roomEpisode, page.titleId, page.episodeId, navigate]);

  const playNext = useCallback(() => {
    if (roomId === null || episodeId === null) return;

    moveOn({ roomId, deviceId, fromEpisodeId: episodeId }).catch((cause: unknown) => {
      setProblem({ from: episodeId, reason: describeFailure(cause) });
    });
  }, [roomId, episodeId, deviceId, moveOn]);

  const cancel = useCallback(() => {
    if (roomId === null || episodeId === null) return;
    const args = { roomId, deviceId, fromEpisodeId: episodeId };

    cancelCountdown(args)
      .catch(() => cancelCountdown(args))
      .catch(() => undefined);
  }, [roomId, episodeId, deviceId, cancelCountdown]);

  const pick = useCallback(
    (picked: EpisodeId) => {
      const current = latestRoom.current;

      if (current === null || picked === current.episode?.id) return;

      const switchTo = (revision: number) =>
        setMedia({
          roomId: current.id,
          deviceId,
          revision,
          titleId: current.title.id,
          episodeId: picked,
        });

      switchTo(current.clock.revision)
        .catch((cause: unknown) =>
          Predicate.isTagged(cause, "StaleRevision")
            ? readRoom({ roomId: current.id }).then((fresh) => switchTo(fresh.clock.revision))
            : Promise.reject(cause),
        )
        .catch(() => undefined);
    },
    [latestRoom, deviceId, setMedia, readRoom],
  );

  const close = useCallback(() => {
    setClosed(
      next?.status === "pending" ? String(next.nextAt) : `unavailable:${String(episodeId)}`,
    );
  }, [next, episodeId]);

  const card = ((): RoomNextCard | null => {
    if (roomId === null || role === null) return null;

    if (next?.status === "pending") {
      return closed === String(next.nextAt)
        ? null
        : { kind: "countdown", episode: next.episode, nextAt: next.nextAt, role };
    }

    if (!hosting || !credits || nextEpisode === null || next !== null) return null;

    if (closed === `unavailable:${String(episodeId)}`) return null;
    const reason = !nextPlays ? FILE_MISSING : problem?.from === episodeId ? problem.reason : null;

    return reason === null ? null : { kind: "unavailable", episode: nextEpisode, reason };
  })();

  return {
    card,
    playNext: hosting && nextPlays ? playNext : null,
    moveOn: playNext,
    cancel,
    close,
    pick: hosting ? pick : null,
  };
};
