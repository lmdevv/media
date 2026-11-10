import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";

import { PlayerScreen } from "@/components/player/player-screen";
import { asTitleId } from "@/lib/catalog";

// IDs from the URL, branded as the platform brands its tables' IDs; the core checks each one.
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
 */
export const Route = createFileRoute("/watch/$titleId")({
  params: {
    parse: (raw) => ({ titleId: asTitleId(raw.titleId) }),
    stringify: (params) => ({ titleId: params.titleId }),
  },
  validateSearch: Schema.toStandardSchemaV1(WatchSearch),
  head: () => ({ meta: [{ title: "Watch · [movies]" }] }),
  component: WatchPage,
});

function WatchPage() {
  const { titleId } = Route.useParams();
  const search = Route.useSearch();

  return (
    <PlayerScreen
      key={`${titleId}:${search.episodeId ?? ""}`}
      titleId={titleId}
      episodeId={search.episodeId}
      version={search.version}
      start={search.start}
    />
  );
}
