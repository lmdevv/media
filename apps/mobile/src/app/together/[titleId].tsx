import type { TitleId } from "@media/contracts/ids";
import type { Episode, TitleDetail } from "@media/contracts/models/catalog";
import { Milliseconds } from "@media/contracts/units";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { CircleAlert, UsersRound } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";

import { RoomArtwork } from "@/components/rooms/room-parts";
import { episodeIdParam, seasonParam, titleIdParam } from "@/components/title/route-params";
import { CENTERED_COLUMN } from "@/components/ui/page-layout";
import { useSeasonEpisode } from "@/components/title/use-season-episode";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { deviceId } from "@/lib/device";
import { describeFailure } from "@/lib/failure";
import { episodeLine } from "@/lib/player/next-episode";
import { roomStart } from "@/lib/rooms/room-start";
import { useActiveProfile } from "@/session/active-profile";
import { useServer } from "@/session/connection";

function StartRoom({
  title,
  chosen,
}: {
  readonly title: TitleDetail;
  readonly chosen: Episode | null;
}) {
  const { profile } = useActiveProfile();
  const { mediaUrl } = useServer();
  const create = useCommand("rooms.create");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = roomStart(title, chosen);
  const { episode } = start;

  const startRoom = () => {
    setBusy(true);
    setError(null);

    const input = {
      profileId: profile.id,
      deviceId: deviceId(),
      titleId: title.id,
      positionMs: Milliseconds.make(start.positionMs),
    };

    void create(start.episodeId === undefined ? input : { ...input, episodeId: start.episodeId })
      .then((room) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace(`/room/${room.id}`);

        return undefined;
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(describeFailure(cause));
      });
  };

  return (
    <ScrollView contentContainerClassName={`gap-4 px-5 py-4 ${CENTERED_COLUMN}`}>
      <RoomArtwork
        uri={artworkUrl(
          mediaUrl,
          episode?.still ?? title.artwork.backdrop ?? title.artwork.poster,
          "backdrop",
        )}
      />
      <View className="gap-1">
        <Text variant="title" accessibilityRole="header">
          {title.name}
        </Text>
        {episode === null ? null : (
          <Text variant="secondary" tone="muted">
            {episodeLine(episode)}
          </Text>
        )}
      </View>
      <Text tone="muted">Invite people from your household.</Text>
      <View className="h-8" />
      {error === null ? null : (
        <Text variant="meta" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      <Button label="Start Room" icon={UsersRound} busy={busy} onPress={startRoom} />
    </ScrollView>
  );
}

const useChosenEpisode = (
  titleId: TitleId | null,
  rawEpisode: string | undefined,
  rawSeason: string | undefined,
) => {
  const episodeId = episodeIdParam(rawEpisode);
  const seasonNumber = seasonParam(rawSeason);
  const episode = useSeasonEpisode(titleId, episodeId, seasonNumber);

  if (rawEpisode === undefined) return { status: "none" } as const;

  if (episodeId === null || seasonNumber === null) return { status: "missing" } as const;

  if (episode.status !== "success") return episode;

  return episode.data === null ? ({ status: "missing" } as const) : episode;
};

export default function WatchTogether() {
  const params = useLocalSearchParams<{ titleId: string; episodeId?: string; season?: string }>();
  const titleId = titleIdParam(params.titleId);
  const { profile } = useActiveProfile();
  const chosen = useChosenEpisode(titleId, params.episodeId, params.season);

  const title = useCommandQuery(
    "titles.get",
    titleId === null ? "skip" : { profileId: profile.id, titleId },
  );

  const failure = title.status === "error" ? title : chosen.status === "error" ? chosen : null;

  return (
    <Screen header={<NavHeader title="Watch Together" />}>
      {chosen.status === "missing" ? (
        <CalmState icon={CircleAlert} title="Episode Not Found" />
      ) : title.status === "success" &&
        (chosen.status === "success" || chosen.status === "none") ? (
        <StartRoom title={title.data} chosen={chosen.status === "success" ? chosen.data : null} />
      ) : failure !== null ? (
        <CalmState
          icon={CircleAlert}
          title="Couldn’t Load This Title"
          description={describeFailure(failure.error)}
          actions={<Button label="Try Again" onPress={failure.retry} />}
        />
      ) : titleId === null ? (
        <CalmState icon={CircleAlert} title="Title Not Found" />
      ) : (
        <ActivityIndicator className="flex-1" colorClassName="accent-text-muted" />
      )}
    </Screen>
  );
}
