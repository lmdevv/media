/**
 * C03 · Liked songs: every song you liked, newest first, with Play and Shuffle. With none yet it
 * is G15, which points to the songs list.
 */
import { router } from "expo-router";
import { Heart, Music } from "lucide-react-native";
import { View } from "react-native";

import { PlayButtons } from "@/components/playlists/play-buttons";
import { SongListPage } from "@/components/playlists/song-list-page";
import { useTrackPages } from "@/components/playlists/use-track-pages";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Page } from "@/components/ui/page";
import { Text } from "@/components/ui/text";
import { countOf } from "@/lib/format";
import { usePlayerActions } from "@/player";

export default function LikedSongs() {
  const liked = useTrackPages("likes.page", { eager: true });
  const { play } = usePlayerActions();

  if (liked === undefined) return <Page title="Liked songs">{null}</Page>;

  if (liked.tracks.length === 0) {
    return (
      <Page title="Liked songs">
        <EmptyState
          icon={Heart}
          title="Keep the good ones."
          body={"Tap the heart on a song\nto find it here."}
          primary={
            <Button label="Browse songs" icon={Music} onPress={() => router.push("/songs")} />
          }
        />
      </Page>
    );
  }

  const trackIds = liked.tracks.map((track) => track.id);

  const count = liked.done
    ? countOf(liked.tracks.length, "song")
    : `${countOf(liked.tracks.length, "song")}+`;

  return (
    <SongListPage
      bar={{ title: "Liked songs" }}
      songs={liked.tracks.map((track) => ({
        key: track.id,
        song: track,
        title: track.title,
        subtitle: track.artist,
        artUrl: track.artUrl,
        playable: true,
      }))}
      onPlay={(index) => void play(trackIds, index)}
      header={
        <>
          <View className="flex-row items-center gap-4 py-mobile-edge">
            <Icon icon={Heart} tone="accent" size="hero" />
            <Text variant="title" accessibilityRole="header">
              {"Your favorites.\nAll together."}
            </Text>
          </View>
          <Text variant="callout" tone="muted">
            {`${count} · saved across your devices`}
          </Text>
          <PlayButtons trackIds={trackIds} second={{ kind: "shuffle" }} className="py-4" />
        </>
      }
    />
  );
}
