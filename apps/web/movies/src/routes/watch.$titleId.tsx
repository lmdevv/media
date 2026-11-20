import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { PlayerScreen } from "@/components/player/player-screen";
import { useSleepTimer } from "@/components/player/use-sleep-timer";
import { asTitleId } from "@/lib/catalog";

const EpisodeId = Schema.NonEmptyString.pipe(Schema.brand("Id<episodes>"));

const MediaFileId = Schema.NonEmptyString.pipe(Schema.brand("Id<mediaFiles>"));

const WatchSearch = Schema.Struct({
  episodeId: Schema.optionalKey(EpisodeId),
  version: Schema.optionalKey(MediaFileId),
  start: Schema.optionalKey(Schema.Literals(["0", "resume"])),
});

/**
 * Playback of a movie or episode: `/watch/<titleId>?episodeId=…&version=…&start=0`. A remount
 * starts a new playback; a change of version does not remount, as the player switches files itself.
 * The sleep timer lives here, above the player, so it carries on into the next episode and ends
 * when the viewer leaves.
 */
export const Route = createFileRoute("/watch/$titleId")({
  params: {
    parse: (raw) => ({ titleId: asTitleId(raw.titleId) }),
    stringify: (params) => ({ titleId: params.titleId }),
  },
  validateSearch: Schema.toStandardSchemaV1(WatchSearch),
  head: () => ({ meta: [{ title: "Watch · Lar Movies" }] }),
  component: WatchPage,
});

function WatchPage() {
  const { titleId } = Route.useParams();
  const search = Route.useSearch();
  const sleepTimer = useSleepTimer();

  return (
    <PlayerScreen
      key={`${titleId}:${search.episodeId ?? ""}`}
      titleId={titleId}
      episodeId={search.episodeId}
      version={search.version}
      start={search.start}
      sleepTimer={sleepTimer}
    />
  );
}
