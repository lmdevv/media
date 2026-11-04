import type { EpisodeId, TitleId } from "@media/contracts/ids";
import { useCommandQuery } from "@media/sdk/react";

import { useActiveProfile } from "@/session/active-profile";

/** The season's episodes as `titles.episodes` answers, narrowed to `episodeId`: null when absent. */
export const useSeasonEpisode = (
  titleId: TitleId | null,
  episodeId: EpisodeId | null,
  seasonNumber: number | null,
) => {
  const { profile } = useActiveProfile();

  const episodes = useCommandQuery(
    "titles.episodes",
    titleId === null || episodeId === null || seasonNumber === null
      ? "skip"
      : { profileId: profile.id, titleId, seasonNumber },
  );

  if (episodes.status !== "success") return episodes;

  const episode = episodes.data.find((candidate) => candidate.id === episodeId);

  return { status: "success", data: episode ?? null } as const;
};
