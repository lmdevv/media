import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { Check, Clapperboard, EyeOff, RotateCcw } from "lucide-react-native";

import { episodeIdParam, seasonParam, titleIdParam } from "@/components/title/route-params";
import { DownloadRow } from "@/components/title/download-row";
import { Sheet, useSheetExit } from "@/components/title/sheet";
import { defaultVersion, episodeSubtitle, resumeOf } from "@/components/title/title-model";
import { useSeasonEpisode } from "@/components/title/use-season-episode";
import { useRunner } from "@/components/title/use-title-actions";
import { ListRow } from "@/components/ui/list-row";
import type { EpisodeId, SeasonEpisode, TitleId } from "@/lib/catalog";
import { watchHref } from "@/lib/routes";

function EpisodeActions({ episode }: { readonly episode: SeasonEpisode }) {
  const platform = usePlatform();
  const { markWatched, markUnwatched } = platform.movies.history;
  const mark = useRunner();
  const exit = useSheetExit();
  const resume = resumeOf(episode.progress);
  const watched = episode.progress?.watched === true;
  const target = { titleId: episode.titleId, episodeId: episode.id };

  const versions = usePlatformQuery(platform.movies.titles.versions, {
    titleId: episode.titleId,
    episodeId: episode.id,
  });

  const show = usePlatformQuery(platform.movies.titles.get, { titleId: episode.titleId });

  const file = versions.status === "success" ? defaultVersion(versions.data) : undefined;

  const toggleWatched = async () => {
    const done = await mark.run(() => (watched ? markUnwatched(target) : markWatched(target)));

    if (done) exit.close();
  };

  return (
    <Sheet title={episode.name} subtitle={episodeSubtitle(episode)} error={mark.error} exit={exit}>
      {resume === null ? null : (
        <ListRow
          icon={RotateCcw}
          title="Play from Beginning"
          disabled={!episode.available}
          onPress={() => exit.leaveFor(watchHref({ ...target, start: "beginning" }))}
        />
      )}
      <ListRow
        icon={watched ? EyeOff : Check}
        title={watched ? "Mark as Unwatched" : "Mark as Watched"}
        disabled={mark.busy}
        onPress={() => void toggleWatched()}
      />
      {episode.available && file !== undefined && show.status === "success" ? (
        <DownloadRow
          target={{ titleId: episode.titleId, episodeId: episode.id, fileId: file.id }}
          exit={exit}
        />
      ) : null}
      {versions.status === "success" && versions.data.length > 1 ? (
        <ListRow
          icon={Clapperboard}
          title="Choose Version"
          detail={`${versions.data.length} versions`}
          onPress={() =>
            exit.switchTo(`/title/${episode.titleId}/versions?episodeId=${episode.id}`)
          }
        />
      ) : null}
    </Sheet>
  );
}

function EpisodeLoader({
  titleId,
  episodeId,
  seasonNumber,
}: {
  readonly titleId: TitleId;
  readonly episodeId: EpisodeId;
  readonly seasonNumber: number;
}) {
  const episode = useSeasonEpisode(titleId, episodeId, seasonNumber);

  if (episode.status !== "ready") {
    return (
      <Sheet
        title="Episode"
        loading={episode.status === "loading"}
        error={episode.status === "failed" ? episode.message : null}
      />
    );
  }

  return episode.episode === null ? (
    <Sheet title="Episode" error="This episode isn't here." />
  ) : (
    <EpisodeActions episode={episode.episode} />
  );
}

export default function EpisodeActionsSheet() {
  const params = useLocalSearchParams<{ titleId: string; episodeId: string; season?: string }>();
  const titleId = titleIdParam(params.titleId);
  const episodeId = episodeIdParam(params.episodeId);
  const seasonNumber = seasonParam(params.season);

  if (titleId === null || episodeId === null || seasonNumber === null) {
    return <Sheet title="Episode" error="This episode isn't here." />;
  }

  return <EpisodeLoader titleId={titleId} episodeId={episodeId} seasonNumber={seasonNumber} />;
}
