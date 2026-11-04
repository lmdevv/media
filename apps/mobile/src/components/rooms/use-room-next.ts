import type { DeviceId, EpisodeId, TitleId } from "@media/contracts/ids";
import type { Room } from "@media/contracts/models/rooms";
import { useCommand } from "@media/sdk/react";
import { router } from "expo-router";
import { Predicate } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import { describeFailure } from "@/lib/failure";
import { closedKey, roomNextCard, shouldStartCountdown } from "@/lib/rooms/room-next";
import type { CountdownProblem, RoomNextCard, RoomNextInput } from "@/lib/rooms/room-next";
import { watchHref } from "@/lib/routes";

const REFUSALS = ["Conflict", "NotFound", "Forbidden", "InvalidArgs"] as const;

const RETRY_MS = 2_000;

/** What the hook needs from the player. */
export interface RoomNextOptions extends Omit<RoomNextInput, "next" | "roomEpisodeId" | "role"> {
  /** The room the player is in, once joined; null outside rooms. */
  readonly room: Room | null;
  readonly role: RoomNextInput["role"] | null;
  readonly deviceId: DeviceId;
  /**
   * What this player plays, which the room's media is compared with; null until its stream starts,
   * so a show opened without an episode is not taken for another one.
   */
  readonly page: { readonly titleId: TitleId; readonly episodeId: EpisodeId | undefined } | null;
}

/** The room's next episode for the player. */
export interface RoomNext {
  readonly card: RoomNextCard | null;
  /** The host's Play Next on the card, moving the room on to the next episode now. */
  readonly moveOn: () => void;
  /** The host's Watch Credits: cancels the countdown for everyone. */
  readonly cancel: () => void;
  /** Closes the card on this screen only: a guest's Close, or the host's on an unavailable card. */
  readonly close: () => void;
  /** Moves the room to another episode of its show: the host's Episodes. Null for guests. */
  readonly pick: ((episodeId: EpisodeId) => void) | null;
}

/** The room's next episode. Outside rooms it does nothing and offers nothing. */
export const useRoomNext = (options: RoomNextOptions): RoomNext => {
  const { room, role, deviceId, page, episodeId } = options;
  const startCountdown = useCommand("rooms.startNextCountdown");
  const cancelCountdown = useCommand("rooms.cancelNextCountdown");
  const playNext = useCommand("rooms.playNext");
  const setMedia = useCommand("rooms.setMedia");
  const readRoom = useCommand("rooms.get");
  const latestRoom = useRef(room);
  const [problem, setProblem] = useState<CountdownProblem | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [closed, setClosed] = useState<string | null>(null);
  const roomId = room?.id ?? null;
  const next = room?.next ?? null;

  useEffect(() => {
    latestRoom.current = room;
  }, [room]);

  const input: RoomNextInput | null =
    room === null || role === null
      ? null
      : {
          role,
          next,
          roomEpisodeId: room.episode?.id ?? null,
          episodeId,
          nextEpisode: options.nextEpisode,
          credits: options.credits,
          canCommand: options.canCommand,
        };

  const start = input !== null && shouldStartCountdown(input);

  useEffect(() => {
    if (!start || roomId === null || episodeId === null) return undefined;

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
  }, [start, roomId, episodeId, deviceId, startCountdown, attempt]);

  const roomTitle = room?.title.id ?? null;
  const roomEpisode = room?.episode?.id;

  const pageTitle = page?.titleId ?? null;
  const pageEpisode = page?.episodeId;

  useEffect(() => {
    if (roomId === null || roomTitle === null || pageTitle === null) return;

    if (roomTitle === pageTitle && roomEpisode === pageEpisode) return;

    router.replace(watchHref({ titleId: roomTitle, episodeId: roomEpisode, room: roomId }));
  }, [roomId, roomTitle, roomEpisode, pageTitle, pageEpisode]);

  const moveOn = useCallback(() => {
    if (roomId === null || episodeId === null) return;

    setProblem(null);
    playNext({ roomId, deviceId, fromEpisodeId: episodeId }).catch((cause: unknown) => {
      setProblem({ from: episodeId, reason: describeFailure(cause) });
    });
  }, [roomId, episodeId, deviceId, playNext]);

  const cancel = useCallback(() => {
    if (roomId === null || episodeId === null) return;
    const args = { roomId, deviceId, fromEpisodeId: episodeId };

    setProblem(null);
    cancelCountdown(args)
      .catch(() => cancelCountdown(args))
      .catch((cause: unknown) => {
        setProblem({ from: episodeId, reason: describeFailure(cause) });
      });
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
        .catch((cause: unknown) => {
          Alert.alert("Couldn’t Switch Episode", describeFailure(cause));
        });
    },
    [deviceId, setMedia, readRoom],
  );

  const close = useCallback(() => setClosed(closedKey(next, episodeId)), [next, episodeId]);

  return {
    card: input === null ? null : roomNextCard(input, closed, problem),
    moveOn,
    cancel,
    close,
    pick: role === "host" && roomId !== null ? pick : null,
  };
};
