import type { EpisodeId } from "@media/contracts/ids";
import type { Episode, Progress, TitleDetail } from "@media/contracts/models/catalog";

/** The media and position a new room starts at. */
export interface RoomStart {
  /** The show's episode; undefined for a movie. */
  readonly episodeId: EpisodeId | undefined;
  readonly positionMs: number;
  /** The episode, for the line under the show's name. */
  readonly episode: Episode | null;
}

const resumeAt = (progress: Progress | null): number =>
  progress === null || progress.watched ? 0 : progress.positionMs;

/** The room `detail`'s page starts, or the room for its `chosen` episode. */
export const roomStart = (
  detail: Pick<TitleDetail, "kind" | "progress" | "nextEpisode">,
  chosen: Episode | null = null,
): RoomStart => {
  if (detail.kind === "movie") {
    return { episodeId: undefined, positionMs: resumeAt(detail.progress), episode: null };
  }

  const next = chosen ?? detail.nextEpisode;

  return next === null
    ? { episodeId: undefined, positionMs: 0, episode: null }
    : { episodeId: next.id, positionMs: resumeAt(next.progress), episode: next };
};
