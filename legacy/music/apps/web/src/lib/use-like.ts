import type { TrackId } from "@music/commands/ids";
import type { Track } from "@music/commands/models";
import { useRun } from "@music/sdk/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { toastFailure } from "@/lib/action";

/** Whether a song is liked, and the toggle that changes it. */
export interface LikeState {
  readonly liked: boolean;
  readonly toggle: () => Promise<void>;
}

/**
 * Like state for one song with optimistic feedback: the heart flips at once, then follows the
 * server, and flips back with an error toast if the change fails.
 */
export const useLike = (track: Pick<Track, "id" | "liked" | "title"> | null): LikeState => {
  const setLike = useRun("likes.set");

  const [optimistic, setOptimistic] = useState<{
    readonly id: TrackId;
    readonly liked: boolean;
  } | null>(null);

  const serverLiked = track?.liked ?? false;
  const liked = optimistic !== null && optimistic.id === track?.id ? optimistic.liked : serverLiked;

  useEffect(() => {
    setOptimistic((current) =>
      current !== null && current.liked === serverLiked ? null : current,
    );
  }, [serverLiked]);

  const toggle = useCallback(async () => {
    if (track === null) return;

    const next = !liked;
    setOptimistic({ id: track.id, liked: next });

    try {
      await setLike({ trackId: track.id, liked: next });
      toast.success(next ? `Liked ${track.title}` : `Removed ${track.title} from Liked songs`);
    } catch (cause) {
      setOptimistic(null);
      toastFailure(cause);
    }
  }, [track, liked, setLike]);

  return { liked, toggle };
};
