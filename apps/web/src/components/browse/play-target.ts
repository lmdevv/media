import type { EpisodeId, MediaFileId, ProfileId, TitleId } from "@media/contracts/ids";
import type { TitleDetail } from "@media/contracts/models/catalog";
import { useCommand } from "@media/sdk/react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { toastFailure } from "@/lib/failure";
import { episodeCode, progressFraction } from "@/lib/format";

/** What the main button of a title does: start, resume, or play the next episode. */
export interface PlayTarget {
  /** `Play`, `Resume`, `Resume S2:E4`, or `Play S1:E1`. */
  readonly label: string;
  readonly resuming: boolean;
  /** The episode to play, for shows. */
  readonly episodeId: EpisodeId | undefined;
  /** Fraction watched of what the button resumes, when it resumes. */
  readonly fraction: number | null;
  /** Where it resumes, in milliseconds. */
  readonly positionMs: number | null;
}

interface WatchLinkSearch {
  episodeId?: EpisodeId;
  start?: "0";
  version?: MediaFileId;
}

/**
 * The `/watch` search for playing `episodeId` (or the movie), from the beginning when `start`, in
 * `version` when the viewer chose one of several files.
 */
export const watchSearch = (
  episodeId: EpisodeId | undefined,
  start: boolean,
  version?: MediaFileId,
): Readonly<WatchLinkSearch> => {
  const search: WatchLinkSearch = {};

  if (episodeId !== undefined) search.episodeId = episodeId;

  if (start) search.start = "0";

  if (version !== undefined) search.version = version;

  return search;
};

/** The main play action of a title page or billboard. */
export const playTarget = (title: TitleDetail): PlayTarget => {
  if (title.kind === "movie") {
    const fraction = title.progress?.watched === true ? null : progressFraction(title.progress);

    return {
      label: fraction === null ? "Play" : "Resume",
      resuming: fraction !== null,
      episodeId: undefined,
      fraction,
      positionMs: fraction === null ? null : (title.progress?.positionMs ?? null),
    };
  }

  const next = title.nextEpisode;

  if (next === null) {
    return {
      label: "Play",
      resuming: false,
      episodeId: undefined,
      fraction: null,
      positionMs: null,
    };
  }

  const fraction = next.progress?.watched === true ? null : progressFraction(next.progress);

  return {
    label: `${fraction === null ? "Play" : "Resume"} ${episodeCode(next)}`,
    resuming: fraction !== null,
    episodeId: next.id,
    fraction,
    positionMs: fraction === null ? null : (next.progress?.positionMs ?? null),
  };
};

/** A title's My List membership and the way to flip it. */
export interface MyListToggle {
  readonly inList: boolean;
  readonly toggle: () => Promise<void>;
}

/**
 * My List membership with an immediate answer: the toggle flips at once and the subscription
 * confirms it; a failure flips it back and says why.
 */
export const useMyListToggle = (
  profileId: ProfileId,
  titleId: TitleId,
  inMyList: boolean,
  name: string,
): MyListToggle => {
  const add = useCommand("myList.add");
  const remove = useCommand("myList.remove");

  const [optimistic, setOptimistic] = useState<{
    readonly from: boolean;
    readonly to: boolean;
  } | null>(null);

  const inList = optimistic !== null && optimistic.from === inMyList ? optimistic.to : inMyList;

  const toggle = useCallback(async () => {
    const next = !inList;

    setOptimistic({ from: inMyList, to: next });

    try {
      await (next ? add({ profileId, titleId }) : remove({ profileId, titleId }));
      toast.success(next ? `Added ${name} to My List` : `Removed ${name} from My List`);
    } catch (cause) {
      setOptimistic(null);
      toastFailure(cause);
    }
  }, [inList, inMyList, add, remove, profileId, titleId, name]);

  return { inList, toggle };
};
