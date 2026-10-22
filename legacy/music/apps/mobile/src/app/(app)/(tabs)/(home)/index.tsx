/**
 * A01 · Home: albums back in rotation and recently added, as rails under the large title, then the
 * songs played most recently, each once. Scrolled past the title it is A14: the compact bar above, and
 * the system tab bar minimized with the mini player inline.
 */
import { useRead } from "@music/sdk/react";
import { router } from "expo-router";
import { View } from "react-native";

import { AlbumRail } from "@/components/browse/album-rail";
import { usePlayList } from "@/components/browse/play";
import { TrackRow } from "@/components/browse/rows";
import { EmptyHome, HomeSkeleton, MoreOnTheWay, ScanNotice } from "@/components/states/home-states";
import { SectionHeader } from "@/components/ui/section-header";
import { TabRoot } from "@/components/ui/tab-root";
import { distinctSongs } from "@/lib/history";
import { useNowPlaying } from "@/player";

/** How many recently played songs Home lists; History has the rest. */
const RECENT_SONGS = 5;

/** Plays read to find them, since one song often plays several times in a row. */
const PLAYS_READ = 50;

/** A14's "Recently played": the latest songs, each once, playing from the one tapped. */
function RecentlyPlayed() {
  const plays = useRead("history.list", { limit: PLAYS_READ });
  const playingId = useNowPlaying().nowPlaying?.trackId ?? null;
  const { playFrom } = usePlayList();

  const songs = distinctSongs(plays ?? [], RECENT_SONGS);
  const songIds = songs.map((song) => song.id);

  if (songs.length === 0) return null;

  return (
    <>
      <SectionHeader
        title="Recently played"
        action={{ kind: "chevron", onPress: () => router.push("/history") }}
      />
      <View className="-mx-mobile-edge">
        {songs.map((song, index) => (
          <TrackRow
            key={song.id}
            song={song}
            artUrl={song.artUrl}
            active={song.id === playingId}
            onPress={() => playFrom(songIds, index)}
          />
        ))}
      </View>
    </>
  );
}

export default function Home() {
  const home = useRead("library.home", {});

  return (
    <TabRoot title="Home">
      {home === undefined ? (
        <HomeSkeleton />
      ) : home.stats.tracks === 0 ? (
        <EmptyHome />
      ) : (
        <>
          <ScanNotice tracks={home.stats.tracks} />
          <AlbumRail
            first
            title="Back in rotation"
            albums={home.recentlyPlayed}
            action={{ kind: "chevron", onPress: () => router.push("/albums") }}
          />
          <AlbumRail
            first={home.recentlyPlayed.length === 0}
            title="Recently added"
            albums={home.recentlyAdded}
            action={{ kind: "link", label: "See all", onPress: () => router.push("/albums") }}
          />
          <MoreOnTheWay />
          <RecentlyPlayed />
        </>
      )}
    </TabRoot>
  );
}
