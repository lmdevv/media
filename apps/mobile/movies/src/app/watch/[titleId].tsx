import { Option } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { CircleAlert } from "lucide-react-native";
import { useCallback } from "react";
import { View } from "react-native";

import { PlayerScreen } from "@/components/player/player-screen";
import { useSleepTimer } from "@/components/player/use-sleep-timer";
import { useStillWatching } from "@/components/player/use-still-watching";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { parseWatchParams } from "@/lib/routes";

/**
 * The player screen. The sleep timer and the count behind "Are you still watching?" live here,
 * above the player, so they carry on into the next episode and end when the player closes.
 */
export default function Watch() {
  const params = Option.getOrNull(parseWatchParams(useLocalSearchParams()));
  const sleepTimer = useSleepTimer();
  const shownTitle = params === null ? null : params.titleId;

  // Back to the title's page under the player, or in the player's place when it opened from
  // elsewhere, such as Home.
  const toTitle = useCallback(() => {
    if (shownTitle === null) router.back();
    else router.dismissTo({ pathname: "/title/[titleId]", params: { titleId: shownTitle } });
  }, [shownTitle]);

  const stillWatching = useStillWatching(toTitle);

  if (params === null) {
    return (
      <View className="flex-1 bg-bg">
        <CalmState
          icon={CircleAlert}
          title="Can't Play This"
          description="This link doesn't name something to play."
          actions={<Button label="Close" onPress={() => router.back()} />}
        />
      </View>
    );
  }

  const { titleId, episodeId, fileId, start, at } = params;

  return (
    <PlayerScreen
      key={[titleId, episodeId, fileId, start, at].join("|")}
      params={params}
      sleepTimer={sleepTimer}
      stillWatching={stillWatching}
    />
  );
}
