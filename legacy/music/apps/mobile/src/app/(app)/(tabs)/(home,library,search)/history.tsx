/**
 * A06 · History: every play, newest first, under a heading for each day. A row plays the history
 * from that song; its ellipsis opens Song actions (A11).
 */
import { useRead } from "@music/sdk/react";
import { Clock } from "lucide-react-native";
import { View } from "react-native";

import { ListPage } from "@/components/browse/list-page";
import { usePlayList } from "@/components/browse/play";
import { TrackRow } from "@/components/browse/rows";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { historyRows } from "@/lib/history";
import { useNowPlaying } from "@/player";

/** The most plays `history.list` returns. */
const HISTORY_LIMIT = 200;

export default function History() {
  const history = useRead("history.list", { limit: HISTORY_LIMIT });
  const playingId = useNowPlaying().nowPlaying?.trackId ?? null;
  const { playFrom } = usePlayList();

  const plays = history ?? [];
  const rows = historyRows(plays, Date.now());
  const trackIds = plays.map((play) => play.track.id);

  return (
    <ListPage
      bar={{ title: "History" }}
      data={rows}
      extraData={playingId}
      keyExtractor={(row) => row.key}
      getItemType={(row) => row.kind}
      footer={
        history !== undefined && history.length === 0 ? (
          <View className="px-mobile-edge">
            <EmptyState
              icon={Clock}
              title={"Nothing played\nyet."}
              body={"Songs you play show up here,\nnewest first."}
            />
          </View>
        ) : null
      }
      renderItem={({ item }) =>
        item.kind === "day" ? (
          <View className="px-mobile-edge">
            <SectionHeader title={item.label} />
          </View>
        ) : (
          <TrackRow
            song={item.play.track}
            artUrl={item.play.track.artUrl}
            active={item.play.track.id === playingId}
            onPress={() => playFrom(trackIds, item.index)}
          />
        )
      }
    />
  );
}
