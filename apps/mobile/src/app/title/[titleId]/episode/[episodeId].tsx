import type { EpisodeId, TitleId } from "@media/contracts/ids";
import type { SeasonEpisode } from "@media/contracts/models/catalog";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { Check, Clapperboard, EyeOff, RotateCcw, UsersRound } from "lucide-react-native";

import { useDownloadAction } from "@/components/downloads/use-download-action";
import { episodeIdParam, seasonParam, titleIdParam } from "@/components/title/route-params";
import { Sheet, useSheetExit } from "@/components/title/sheet";
import { episodeSubtitle, resumeOf } from "@/components/title/title-model";
import { useSeasonEpisode } from "@/components/title/use-season-episode";
import { useRunner } from "@/components/title/use-title-actions";
import { ListRow } from "@/components/ui/list-row";
import { describeFailure } from "@/lib/failure";
import { togetherHref, watchHref } from "@/lib/routes";
import { useActiveProfile } from "@/session/active-profile";

function EpisodeActions({ episode }: { readonly episode: SeasonEpisode }) {
  const { profile } = useActiveProfile();
  const markWatched = useCommand("history.markWatched");
  const markUnwatched = useCommand("history.markUnwatched");
  const mark = useRunner();
  const exit = useSheetExit();
  const resume = resumeOf(episode.progress);
  const watched = episode.progress?.watched === true;
  const target = { titleId: episode.titleId, episodeId: episode.id };

  const versions = useCommandQuery("titles.versions", {
    profileId: profile.id,
    titleId: episode.titleId,
    episodeId: episode.id,
  });

  const show = useCommandQuery("titles.get", { profileId: profile.id, titleId: episode.titleId });

  const download = useDownloadAction({
    profileId: profile.id,
    titleId: episode.titleId,
    episodeId: episode.id,
    fileId: null,
    titleName: show.status === "success" ? show.data.name : "",
    episodeName: episode.name,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
    runtimeMs: episode.runtimeMs,
    artwork: episode.still,
  });

  const toggleWatched = async () => {
    const args = { profileId: profile.id, ...target };
    const done = await mark.run(() => (watched ? markUnwatched(args) : markWatched(args)));

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
      <ListRow
        icon={UsersRound}
        title="Watch Together"
        disabled={!episode.available}
        onPress={() =>
          exit.leaveFor(
            togetherHref({
              titleId: episode.titleId,
              episode: { id: episode.id, seasonNumber: episode.seasonNumber },
            }),
          )
        }
      />
      {episode.available && download !== null && show.status === "success" ? (
        <ListRow
          icon={download.icon}
          title={download.title}
          detail={download.detail}
          onPress={() => {
            const page = download.press();

            if (page === null) exit.close();
            else exit.leaveFor(page);
          }}
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

  if (episode.status !== "success") {
    return (
      <Sheet
        title="Episode"
        loading={episode.status === "loading"}
        error={episode.status === "error" ? describeFailure(episode.error) : null}
      />
    );
  }

  return episode.data === null ? (
    <Sheet title="Episode" error="This episode isn't here." />
  ) : (
    <EpisodeActions episode={episode.data} />
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
