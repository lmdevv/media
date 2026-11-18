import type { TitleCard } from "@/lib/catalog";
import { Link, router } from "expo-router";
import type { ReactElement } from "react";

import { useTitleStates } from "./title-states";

/**
 * The context menu for `title`, playing `playHref`. Returns the `Link.Menu` element itself, since
 * `Link` finds its menu among its direct children.
 */
export const useTitleMenu = (title: TitleCard, playHref: string): ReactElement => {
  const states = useTitleStates();
  const inList = states.inMyList(title.id);
  const watched = states.watchState(title.id);

  return (
    <Link.Menu>
      {title.available ? (
        <Link.MenuAction icon="play.fill" onPress={() => router.push(playHref)}>
          {watched === "started" && title.kind === "movie" ? "Resume" : "Play"}
        </Link.MenuAction>
      ) : null}
      {inList ? (
        <Link.MenuAction icon="checkmark" onPress={() => void states.removeFromMyList(title)}>
          Remove from My List
        </Link.MenuAction>
      ) : (
        <Link.MenuAction icon="plus" onPress={() => void states.addToMyList(title)}>
          Add to My List
        </Link.MenuAction>
      )}
      {watched === "watched" ? null : (
        <Link.MenuAction icon="checkmark.circle" onPress={() => void states.markWatched(title)}>
          Mark as Watched
        </Link.MenuAction>
      )}
      {watched === null ? null : (
        <Link.MenuAction
          icon="arrow.uturn.backward.circle"
          onPress={() => void states.markUnwatched(title)}
        >
          Mark as Unwatched
        </Link.MenuAction>
      )}
      <Link.MenuAction icon="info.circle" onPress={() => router.push(`/title/${title.id}`)}>
        Go to Title
      </Link.MenuAction>
    </Link.Menu>
  );
};
