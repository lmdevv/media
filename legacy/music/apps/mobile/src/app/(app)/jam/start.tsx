/**
 * D01 · Start a Jam, a sheet over Now Playing: what a Jam is, the song it starts from, and Start.
 * Starting closes Now Playing and opens the new Jam (D02) over the tabs. Joining someone else's
 * Jam (D12) starts here too, since Paper draws no other way in.
 */
import { errorMessage } from "@music/sdk/errors";
import { useRun } from "@music/sdk/react";
import { router } from "expo-router";
import { Users } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Artwork } from "@/components/ui/artwork";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { Text } from "@/components/ui/text";
import { useNowPlaying } from "@/player";
import type { PlayerRole } from "@/player";

/** Where the song plays, after its artist. */
const whereLine = (role: PlayerRole): string =>
  role.kind === "remote" ? `Playing on ${role.device.name}` : "Playing on this iPhone";

/** The song the Jam starts from: Paper's row without the hairline. */
function StartingSong() {
  const { nowPlaying, role } = useNowPlaying();

  if (nowPlaying === null) return null;

  return (
    <View
      className="min-h-16 flex-row items-center gap-3 py-2"
      accessible
      accessibilityLabel={`${nowPlaying.title}, ${nowPlaying.artist}, ${whereLine(role)}`}
    >
      <Artwork url={nowPlaying.artUrl} className="size-12 shrink-0 rounded-md" />
      <View className="min-w-0 flex-1">
        <Text variant="bodyMedium" numberOfLines={1}>
          {nowPlaying.title}
        </Text>
        <Text variant="secondary" tone="muted" numberOfLines={1}>
          {`${nowPlaying.artist} · ${whereLine(role)}`}
        </Text>
      </View>
    </View>
  );
}

export default function StartJam() {
  const start = useRun("jam.start");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const startJam = async () => {
    setPending(true);
    setFailure(null);

    try {
      await start({});
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Couldn’t start a Jam. Try again.");
      setPending(false);

      return;
    }

    router.dismissAll();
    router.push("/jam");
  };

  return (
    <SheetLayout
      title="Listen together"
      subtitle="Start a Jam from what’s playing. Invite people to share your queue."
      actions={
        <>
          <Button
            label="Start a Jam"
            pendingLabel="Starting…"
            icon={Users}
            pending={pending}
            onPress={() => void startJam()}
          />
          <Button
            label="Join someone’s Jam"
            variant="secondary"
            onPress={() => {
              router.dismissAll();
              router.push("/jam/join");
            }}
          />
        </>
      }
    >
      <View className="gap-4 pb-4">
        <StartingSong />
        <Notice
          icon={Users}
          title="You’re in control"
          body="Choose who can join, add songs, and control playback."
        />
        {failure === null ? null : (
          <Text variant="calloutMedium" tone="danger">
            {failure}
          </Text>
        )}
      </View>
    </SheetLayout>
  );
}
