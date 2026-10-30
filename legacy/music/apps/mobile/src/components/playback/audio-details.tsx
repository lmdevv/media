/**
 * Audio details (B09): the current song's file, gapless playback, and this phone's streaming
 * quality, read-only, with a way to the Playback settings. Paper draws no way in on Now Playing;
 * it opens from Song actions on the playing song, or the ellipsis for a private Jam song.
 */
import { router, useNavigation } from "expo-router";
import { Music, Repeat, Settings } from "lucide-react-native";

import { Button } from "@/components/ui/button";
import { Row } from "@/components/ui/row";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { codecName, fileDetails, qualityName } from "@/lib/playback-format";
import { usePlayer } from "@/player";
import type { NowPlaying } from "@/player";

/**
 * Closes this sheet, and Now Playing when it is under it, then opens the Playback settings over
 * what the person was on, such as a Jam page.
 */
const useOpenPlaybackSettings = () => {
  const navigation = useNavigation();

  return () => {
    const routes = navigation.getState()?.routes ?? [];
    const player = routes.findIndex((route) => route.name === "player");
    router.dismiss(player === -1 ? 1 : routes.length - player);
    router.push("/settings/playback");
  };
};

/** The song's file, gapless playback, and this device's quality, in the sheet and the iPad's panel. */
export function AudioDetailRows({ song }: { readonly song: NowPlaying }) {
  const { quality } = usePlayer();

  return (
    <>
      <Row
        title={song.lossless ? "Lossless" : codecName(song.codec)}
        subtitle={fileDetails(song)}
        leading={{ kind: "icon", icon: Music }}
      />
      <Row
        title="Gapless playback"
        subtitle="Album transitions without gaps"
        leading={{ kind: "icon", icon: Repeat }}
      />
      <Row
        title="Streaming quality"
        subtitle={`${qualityName(quality)} · change in Playback settings`}
        leading={{ kind: "icon", icon: Settings }}
      />
    </>
  );
}

/** The sheet's content for the song playing now. */
export function AudioDetails() {
  const { nowPlaying } = usePlayer();
  const openPlaybackSettings = useOpenPlaybackSettings();

  if (nowPlaying === null) {
    return <SheetLayout title="Audio details" subtitle="Nothing is playing." />;
  }

  return (
    <SheetLayout
      title="Audio details"
      subtitle={`${nowPlaying.title} · ${nowPlaying.album}`}
      actions={
        <Button label="Playback settings" variant="secondary" onPress={openPlaybackSettings} />
      }
    >
      <AudioDetailRows song={nowPlaying} />
    </SheetLayout>
  );
}
