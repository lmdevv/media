import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useCallback } from "react";

import { PlayerScreen } from "@/components/player/player-screen";
import { useSleepTimer } from "@/components/player/use-sleep-timer";
import { useStillWatching } from "@/components/player/use-still-watching";
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
 * The sleep timer and the count behind "Are you still watching?" live here, above the player, so
 * they carry on into the next episode and end when the viewer leaves.
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
  const navigate = useNavigate();

  const toTitle = useCallback(() => {
    void navigate({ to: "/title/$titleId", params: { titleId } });
  }, [navigate, titleId]);

  const stillWatching = useStillWatching(toTitle);

  return (
    <PlayerScreen
      key={`${titleId}:${search.episodeId ?? ""}`}
      titleId={titleId}
      episodeId={search.episodeId}
      version={search.version}
      start={search.start}
      sleepTimer={sleepTimer}
      stillWatching={stillWatching}
    />
  );
}
