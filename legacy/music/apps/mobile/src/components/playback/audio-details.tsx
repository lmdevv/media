/**
 * Audio details (B09): the current song's file, gapless playback, and this phone's streaming
 * quality, read-only, with a way to the Playback settings. Paper draws no way in on Now Playing;
 * it opens from the Now Playing menu.
 */
import { router } from "expo-router";
import { Music, Repeat, Settings } from "lucide-react-native";

import { Button } from "@/components/ui/button";
import { Row } from "@/components/ui/row";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { codecName, fileDetails, qualityName } from "@/lib/playback-format";
import { usePlayer } from "@/player";

/** The sheet's content for the song playing now. */
export function AudioDetails() {
  const { nowPlaying, quality } = usePlayer();

  if (nowPlaying === null) {
    return <SheetLayout title="Audio details" subtitle="Nothing is playing." />;
  }

  return (
    <SheetLayout
      title="Audio details"
      subtitle={`${nowPlaying.title} · ${nowPlaying.album}`}
      actions={
        <Button
          label="Playback settings"
          variant="secondary"
          onPress={() => {
            router.dismissAll();
            router.back();
            router.push("/settings/playback");
          }}
        />
      }
    >
      <Row
        title={nowPlaying.lossless ? "Lossless" : codecName(nowPlaying.codec)}
        subtitle={fileDetails(nowPlaying)}
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
    </SheetLayout>
  );
}
