import { Option } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { CircleAlert } from "lucide-react-native";
import { View } from "react-native";

import { PlayerScreen } from "@/components/player/player-screen";
import { useSleepTimer } from "@/components/player/use-sleep-timer";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { parseWatchParams } from "@/lib/routes";

/**
 * The player screen. The sleep timer lives here, above the player, so it carries on into the next
 * episode and ends when the player closes.
 */
export default function Watch() {
  const params = parseWatchParams(useLocalSearchParams());
  const sleepTimer = useSleepTimer();

  if (Option.isNone(params)) {
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

  const { titleId, episodeId, fileId, start, at } = params.value;

  return (
    <PlayerScreen
      key={[titleId, episodeId, fileId, start, at].join("|")}
      params={params.value}
      sleepTimer={sleepTimer}
    />
  );
}
