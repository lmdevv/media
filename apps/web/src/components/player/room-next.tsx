import type { ClockOffset } from "@media/contracts/clock";
import type { Room } from "@media/contracts/models/rooms";
import { RoomSync } from "@media/sdk/effect";

import { artworkUrl } from "@/lib/artwork";
import { useNow } from "@/lib/use-now";

import { AutoplayNext } from "./autoplay-next";
import type { NextEpisodeActions } from "./autoplay-next";
import type { RoomNextCard } from "./use-room-next";

const TICK_MS = 250;

/**
 * The card for `card` in `room`, its countdown read with `offset` (null until the engine has
 * estimated it, when the device's clock stands in).
 */
export function RoomNextEpisode({
  room,
  offset,
  card,
  onPlayNext,
  onWatchCredits,
  onClose,
}: {
  readonly room: Room;
  readonly offset: ClockOffset | null;
  readonly card: RoomNextCard;
  readonly onPlayNext: () => void;
  readonly onWatchCredits: () => void;
  readonly onClose: () => void;
}) {
  const now = useNow(TICK_MS);
  const countdownMs = RoomSync.nextEpisodeCountdownMs({ room, offset }, now) ?? 0;

  const actions: NextEpisodeActions =
    card.kind === "unavailable"
      ? { kind: "unavailable", reason: card.reason, onClose }
      : card.role === "host"
        ? { kind: "advance", countdownMs, onPlayNext, onWatchCredits }
        : { kind: "follow", countdownMs, onClose };

  return (
    <AutoplayNext
      next={card.episode}
      still={artworkUrl(card.episode.still, "card")}
      actions={actions}
    />
  );
}
