/**
 * C04 · New playlist: a name, an optional description, and Create. Opened from a song's Add to
 * playlist (C06), it starts with that song. It opens the new playlist (C05, or C02 with the song).
 */
import { TrackId } from "@music/commands/ids";
import { errorMessage } from "@music/sdk/errors";
import { useRun } from "@music/sdk/react";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { Check, ListMusic, Lock } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { PlaylistFields, isSavable } from "@/components/playlists/playlist-fields";
import type { PlaylistText } from "@/components/playlists/playlist-fields";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";

export default function NewPlaylist() {
  const { trackId } = useLocalSearchParams<{ trackId?: string }>();
  const create = useRun("playlists.create");
  const [text, setText] = useState<PlaylistText>({ name: "", description: "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = isSavable(text) && !pending;

  const submit = async () => {
    if (!ready) return;
    setPending(true);
    setError(null);

    try {
      const fields = { name: text.name.trim(), description: text.description.trim() };

      const { playlistId } = await create(
        trackId === undefined ? fields : { ...fields, trackIds: [TrackId.make(trackId)] },
      );

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
      router.push({ pathname: "/playlist/[id]", params: { id: playlistId } });
    } catch (cause) {
      setError(cause instanceof Error ? errorMessage(cause) : "Something went wrong. Try again.");
      setPending(false);
    }
  };

  return (
    <Page
      title="New playlist"
      bottom="plain"
      trailing={
        <IconButton
          icon={Check}
          label="Create playlist"
          disabled={!ready}
          className={ready ? "" : "opacity-disabled"}
          onPress={() => void submit()}
        />
      }
    >
      <View className="gap-6">
        <View className="items-center pt-6 pb-2">
          <View className="size-ios-160 items-center justify-center rounded-mobile-card bg-surface">
            <Icon icon={ListMusic} tone="muted" size="state" />
          </View>
        </View>
        <View>
          <PlaylistFields
            value={text}
            onChange={setText}
            descriptionLabel="Description (optional)"
            onSubmit={() => void submit()}
            error={error}
            autoFocus
          />
        </View>
        <Notice
          icon={Lock}
          title="Private to start"
          body="You can share it with people on your server whenever you’re ready."
        />
        <Button
          label="Create playlist"
          pendingLabel="Creating…"
          pending={pending}
          disabled={!isSavable(text)}
          onPress={() => void submit()}
        />
      </View>
    </Page>
  );
}
