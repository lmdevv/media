import type {
  ContinueWatchingItem,
  Episode,
  EpisodeId,
  Progress,
  TitleDetail,
} from "@/lib/catalog";
import { episodeCode } from "@/lib/format";

import { playTarget } from "./play-target";

/**
 * A row of a title's context menu, in the iOS long-press menu's order: play, My List, mark
 * watched or unwatched, then go to the title. `episodeId` aims an item at one episode; without it,
 * the item acts on the movie or the whole show.
 */
export type MenuItem =
  | {
      readonly kind: "play";
      readonly label: string;
      readonly episodeId: EpisodeId | undefined;
    }
  | { readonly kind: "myList"; readonly inList: boolean }
  | {
      readonly kind: "mark";
      readonly watched: boolean;
      readonly episodeId: EpisodeId | undefined;
    }
  | { readonly kind: "goToTitle" };

type WatchState = "unwatched" | "started" | "watched";

const stateOf = (progress: Progress | null): WatchState =>
  progress === null ? "unwatched" : progress.watched ? "watched" : "started";

/**
 * How much of a title the person has watched, from its page's answer. A show is watched when it
 * has no next episode, and unwatched when its next is a first episode never started.
 */
const titleState = (detail: Pick<TitleDetail, "kind" | "progress" | "nextEpisode">): WatchState => {
  if (detail.kind === "movie") return stateOf(detail.progress);

  const next = detail.nextEpisode;

  if (next === null) return "watched";

  if (next.progress !== null) return "started";

  return next.seasonNumber <= 1 && next.episodeNumber === 1 ? "unwatched" : "started";
};

const marks = (state: WatchState, episodeId: EpisodeId | undefined): ReadonlyArray<MenuItem> => [
  ...(state === "watched" ? [] : [{ kind: "mark", watched: true, episodeId } as const]),
  ...(state === "unwatched" ? [] : [{ kind: "mark", watched: false, episodeId } as const]),
];

/**
 * The menu of a poster or landscape card. Until the title's page answers, it holds only Go to
 * title.
 */
export const titleMenu = (
  available: boolean,
  detail: Pick<TitleDetail, "kind" | "progress" | "nextEpisode" | "inMyList"> | undefined,
): ReadonlyArray<MenuItem> => {
  if (detail === undefined) return [{ kind: "goToTitle" }];

  const target = playTarget(detail);

  return [
    ...(available
      ? [{ kind: "play", label: target.label, episodeId: target.episodeId } as const]
      : []),
    { kind: "myList", inList: detail.inMyList },
    ...marks(titleState(detail), undefined),
    { kind: "goToTitle" },
  ];
};

/**
 * The menu of a Continue watching card, aimed at its movie or the episode in progress. `inMyList`
 * is undefined until the title's page answers.
 */
export const continueMenu = (
  item: {
    readonly title: Pick<ContinueWatchingItem["title"], "available">;
    readonly episode: Pick<Episode, "id" | "available" | "seasonNumber" | "episodeNumber"> | null;
    readonly progress: Progress | null;
  },
  inMyList: boolean | undefined,
): ReadonlyArray<MenuItem> => {
  const episodeId = item.episode?.id;
  const resuming = item.progress !== null && !item.progress.watched;
  const verb = resuming ? "Resume" : "Play";
  const available = item.episode?.available ?? item.title.available;

  return [
    ...(available
      ? [
          {
            kind: "play",
            label: item.episode === null ? verb : `${verb} ${episodeCode(item.episode)}`,
            episodeId,
          } as const,
        ]
      : []),
    ...(inMyList === undefined ? [] : [{ kind: "myList", inList: inMyList } as const]),
    ...marks(stateOf(item.progress), episodeId),
    { kind: "goToTitle" },
  ];
};

/** The menu of an episode on its show's page: play it, and mark it watched or unwatched. */
export const episodeMenu = (episode: {
  readonly id: EpisodeId;
  readonly available: boolean;
  readonly progress: Progress | null;
}): ReadonlyArray<MenuItem> => {
  const state = stateOf(episode.progress);

  return [
    ...(episode.available
      ? [
          {
            kind: "play",
            label: state === "started" ? "Resume" : "Play",
            episodeId: episode.id,
          } as const,
        ]
      : []),
    ...marks(state, episode.id),
  ];
};
