import { EpisodePopover } from "@media/ui/components/episode-popover";
import type { EpisodeOption } from "@media/ui/components/episode-popover";
import { useMemo, useState } from "react";
import type { ReactElement } from "react";

import { artworkUrl } from "@/lib/artwork";
import type { EpisodeId, SeasonEpisode, TitleDetail, TitleId } from "@/lib/catalog";
import { episodeRuntimeFacts, progressFraction } from "@/lib/format";

import { useSeasonEpisodes } from "./use-season-episodes";

const episodeDetail = (episode: SeasonEpisode): string | undefined => {
  const parts = episodeRuntimeFacts(episode);

  return parts === "" ? undefined : parts;
};

const episodeOption = (episode: SeasonEpisode): EpisodeOption<EpisodeId> => ({
  id: episode.id,
  episodeNumber: episode.episodeNumber,
  title: episode.name,
  detail: episodeDetail(episode),
  image: artworkUrl(episode.still, "card"),
  progress: progressFraction(episode.progress) ?? undefined,
  available: episode.available,
});

/**
 * The Episodes popover on `trigger`.
 *
 * @param current - The episode playing; the panel opens on its season, with it marked.
 * @param currentSeason - The episodes of the season playing, which the player already has; null
 *   while they load, empty if they could not. Only other seasons are fetched here.
 * @param onPlay - Plays another episode; choosing the one playing only closes the panel.
 */
export function EpisodePicker({
  trigger,
  container,
  open,
  onOpenChange,
  titleId,
  seasons,
  current,
  currentSeason,
  onPlay,
}: {
  readonly trigger: ReactElement;
  readonly container: HTMLElement | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly titleId: TitleId;
  readonly seasons: TitleDetail["seasons"];
  readonly current: { readonly id: EpisodeId; readonly seasonNumber: number };
  readonly currentSeason: ReadonlyArray<SeasonEpisode> | null;
  readonly onPlay: (episodeId: EpisodeId) => void;
}) {
  const [browsing, setBrowsing] = useState<number | null>(null);
  const seasonNumber = browsing ?? current.seasonNumber;

  const browsingOther = seasonNumber !== current.seasonNumber;

  const other = useSeasonEpisodes(titleId, browsingOther ? seasonNumber : null);
  const loaded = browsingOther ? other : currentSeason;
  const episodes = useMemo(() => loaded?.map(episodeOption) ?? null, [loaded]);

  return (
    <EpisodePopover
      trigger={trigger}
      container={container}
      open={open}
      onOpenChange={onOpenChange}
      onClosed={() => setBrowsing(null)}
      seasons={seasons}
      seasonNumber={seasonNumber}
      onSeasonChange={setBrowsing}
      episodes={episodes}
      currentId={current.id}
      onSelect={(option) => {
        onOpenChange(false);

        if (option.id !== current.id) onPlay(option.id);
      }}
    />
  );
}
