import { Option } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { CircleAlert } from "lucide-react-native";
import { View } from "react-native";

import { PlayerScreen } from "@/components/player/player-screen";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { parseWatchParams } from "@/lib/routes";

export default function Watch() {
  const params = parseWatchParams(useLocalSearchParams());

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
    <PlayerScreen key={[titleId, episodeId, fileId, start, at].join("|")} params={params.value} />
  );
}
