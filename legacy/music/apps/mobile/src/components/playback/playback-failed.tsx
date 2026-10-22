/**
 * Can't play right now (G06): playback failed, here, on this phone. The queue and the position
 * stay as they were; the sheet says what failed and offers to load the song again or to keep
 * browsing, which still works while only the media service is down.
 */
import { router } from "expo-router";
import { Server } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { Text } from "@/components/ui/text";
import { displayHost } from "@/lib/server";
import { useConnection } from "@/session/connection";
import { usePlayer, usePlayerActions } from "@/player";

/** The failure sheet over Now Playing. */
export function PlaybackFailed() {
  const { status, error } = usePlayer();
  const { retry } = usePlayerActions();
  const { origin } = useConnection();
  const [retrying, setRetrying] = useState(false);

  // A retry that plays closes the sheet; one that fails again keeps it, with the new reason.
  useEffect(() => {
    if (!retrying) return;

    if (status === "playing" || status === "paused") router.back();
    else if (status === "failed") setRetrying(false);
  }, [retrying, status]);

  return (
    <SheetLayout
      title="Music is taking a moment"
      subtitle="The media service isn’t responding. Your queue and place are saved."
    >
      <Notice
        icon={Server}
        title={`${displayHost(origin)} is connected`}
        body="Library browsing still works. Playback will return when the media service is available."
      />
      {error === null ? null : (
        <Text variant="secondary" tone="muted" className="pt-3" accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      <View className="flex-row gap-3 pt-mobile-edge">
        <Button
          label="Try again"
          pendingLabel="Trying…"
          pending={retrying}
          className="flex-1"
          onPress={() => {
            setRetrying(true);
            retry();
          }}
        />
        <Button
          label="Browse music"
          variant="secondary"
          className="flex-1"
          onPress={() => {
            router.dismissAll();
            router.back();
            router.navigate("/(app)/(tabs)/(library)");
          }}
        />
      </View>
    </SheetLayout>
  );
}
