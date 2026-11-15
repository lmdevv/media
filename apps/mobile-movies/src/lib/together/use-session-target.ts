import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { useMemo } from "react";

import type { MoviesItem, WatchTarget } from "@/lib/together/session";

/** Where a session's item plays in the movies client, as it resolves. */
export type SessionTarget =
  | { readonly status: "loading" }
  /** The viewer may not play the item, or it names nothing the movies client plays. */
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly target: WatchTarget };

const LOADING: SessionTarget = { status: "loading" };

const UNAVAILABLE: SessionTarget = { status: "unavailable" };

/**
 * The movie or episode `item` names, for the player. A title plays as itself; an episode is looked
 * up for its show, since starting playback names both. A null item is one the viewer may not play.
 */
export const useSessionTarget = (item: MoviesItem | null): SessionTarget => {
  const platform = usePlatform();
  const episodeId = item?.ref.type === "episode" ? item.ref.id : null;

  const episode = usePlatformQuery(
    platform.movies.titles.episode,
    ...(episodeId === null ? (["skip"] as const) : ([{ episodeId }] as const)),
  );

  const titleId = episode.status === "success" ? episode.data.titleId : null;

  const movie = item?.ref.type === "title" ? item.ref.id : null;
  const failed = episode.status === "error";

  return useMemo((): SessionTarget => {
    if (movie !== null) return { status: "ready", target: { titleId: movie, episodeId: null } };

    if (episodeId === null || failed) return UNAVAILABLE;

    return titleId === null ? LOADING : { status: "ready", target: { titleId, episodeId } };
  }, [movie, episodeId, failed, titleId]);
};
