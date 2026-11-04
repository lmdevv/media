import { EpisodeId, MediaFileId, RoomId, TitleId } from "@media/contracts/ids";
import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { PlayerScreen } from "@/components/player/player-screen";
import { CurrentRoomProvider } from "@/lib/current-room";
import { RequireProfile, RequireSignedIn } from "@/session/guards";

const decodeTitleId = Schema.decodeSync(TitleId);

const WatchSearch = Schema.Struct({
  episodeId: Schema.optionalKey(EpisodeId),
  version: Schema.optionalKey(MediaFileId),
  start: Schema.optionalKey(Schema.Literals(["0", "resume"])),
  room: Schema.optionalKey(RoomId),
  together: Schema.optionalKey(Schema.Literal("1")),
});

/**
 * Playback of a movie or episode: `/watch/<titleId>?episodeId=…&version=…&start=0`, with
 * `room=<roomId>` to watch together. A remount starts a new playback session; a change of version
 * does not remount, as the player switches files itself.
 */
export const Route = createFileRoute("/watch/$titleId")({
  params: {
    parse: (raw) => ({ titleId: decodeTitleId(raw.titleId) }),
    stringify: (params) => ({ titleId: params.titleId }),
  },
  validateSearch: Schema.toStandardSchemaV1(WatchSearch),
  head: () => ({ meta: [{ title: "Watch · [movies]" }] }),
  component: () => (
    <RequireSignedIn>
      <RequireProfile>
        <WatchPage />
      </RequireProfile>
    </RequireSignedIn>
  ),
});

function WatchPage() {
  const { titleId } = Route.useParams();
  const search = Route.useSearch();

  return (
    <CurrentRoomProvider keepPlace={search.room === undefined}>
      <PlayerScreen
        key={`${titleId}:${search.episodeId ?? ""}`}
        titleId={titleId}
        episodeId={search.episodeId}
        version={search.version}
        start={search.start}
        roomId={search.room}
        together={search.together === "1"}
      />
    </CurrentRoomProvider>
  );
}
