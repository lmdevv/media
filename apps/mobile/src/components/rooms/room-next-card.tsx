import type { ClockOffset } from "@media/contracts/clock";
import type { Room } from "@media/contracts/models/rooms";
import { RoomSync } from "@media/sdk/effect";

import { NEXT_COUNTDOWN } from "@/lib/player/next-episode";
import type { RoomNextCard } from "@/lib/rooms/room-next";

import { NextEpisodeCard } from "../player/next-episode-card";
import { useNow } from "./room-parts";

/** Props for `RoomNextEpisodeCard`. */
export interface RoomNextEpisodeCardProps {
  readonly room: Room;
  readonly offset: ClockOffset | null;
  readonly card: RoomNextCard;
  readonly show: string;
  readonly playing: string | null;
  readonly stillUrl: string | undefined;
  readonly onPlayNext: () => void;
  readonly onWatchCredits: () => void;
  readonly onClose: () => void;
}

/** The card for `card` in `room`. */
export function RoomNextEpisodeCard(props: RoomNextEpisodeCardProps) {
  const { card } = props;
  const now = useNow(card.kind === "countdown", NEXT_COUNTDOWN.stepMs / 4);

  const countdownMs =
    RoomSync.nextEpisodeCountdownMs({ room: props.room, offset: props.offset }, now) ?? 0;

  const actions =
    card.kind === "countdown" && card.role === "host"
      ? { onWatchCredits: props.onWatchCredits, onPlayNext: props.onPlayNext }
      : { onWatchCredits: props.onClose, onPlayNext: null, dismissLabel: "Close" };

  return (
    <NextEpisodeCard
      show={props.show}
      playing={props.playing}
      next={card.episode}
      stillUrl={props.stillUrl}
      countdownMs={countdownMs}
      headline={card.kind === "unavailable" ? card.reason : (card.problem ?? undefined)}
      {...actions}
    />
  );
}
