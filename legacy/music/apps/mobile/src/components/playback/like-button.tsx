/** The heart on Now Playing and the iPad's player bar. */
import type { TrackId } from "@music/commands/ids";
import { useRun } from "@music/sdk/react";
import * as Haptics from "expo-haptics";
import { Heart } from "lucide-react-native";
import { useState } from "react";

import { useSave } from "@/components/states/save-failure";
import { IconButton } from "@/components/ui/icon-button";

/**
 * The heart: likes or unlikes the song at once, and settles on what the server keeps; a refusal
 * opens G13 to send it again.
 */
export function LikeButton({
  trackId,
  liked,
  size = "nav",
}: {
  readonly trackId: TrackId;
  readonly liked: boolean;
  /** The heart: 24 on Now Playing, 22 in the iPad's player bar. */
  readonly size?: "nav" | "side";
}) {
  const setLiked = useRun("likes.set");
  const save = useSave();

  const [pending, setPending] = useState<{
    readonly trackId: TrackId;
    readonly liked: boolean;
  } | null>(null);

  const shown = pending?.trackId === trackId ? pending.liked : liked;

  const toggle = async () => {
    const next = !shown;
    setPending({ trackId, liked: next });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    await save(
      async () => {
        await setLiked({ trackId, liked: next });
      },
      next ? "This song isn’t in your liked songs." : "This song is still in your liked songs.",
    );
    setPending(null);
  };

  return (
    <IconButton
      icon={Heart}
      label={shown ? "Unlike" : "Like"}
      tone={shown ? "accent" : "default"}
      filled={shown}
      size={size}
      accessibilityState={{ selected: shown }}
      onPress={() => void toggle()}
    />
  );
}
