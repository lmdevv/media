import type { Episode, TitleCard } from "@/lib/catalog";
import { Link, router } from "expo-router";
import type { ReactElement } from "react";

import { useDownloadMenuItem } from "@/components/downloads/use-download-menu-item";
import { resumeOf } from "@/components/title/title-model";
import { useTitlePress } from "@/lib/open-title";

import { useTitleStates } from "./title-states";

/** What a card's menu acts on: a title, or one episode of a show. */
export interface MenuTarget {
  readonly title: TitleCard;
  /** The episode the card shows, with the person's progress through it; null for a title. */
  readonly episode: Pick<Episode, "id" | "available" | "progress"> | null;
}

/** Which marks the menu offers: Watched unless it is, Unwatched once it has any progress. */
interface Marks {
  readonly watched: boolean;
  readonly unwatched: boolean;
}

/**
 * The context menu for `target`, playing `playHref`: Play or Resume, My List, the watched marks,
 * Download, and Go to Title. An episode's card aims Play, the marks, and Download at its episode.
 * Returns the `Link.Menu` element itself, since `Link` finds its menu among its direct children.
 */
export const useTitleMenu = ({ title, episode }: MenuTarget, playHref: string): ReactElement => {
  const states = useTitleStates();
  const inList = states.inMyList(title.id);
  const titleState = states.watchState(title.id);
  const available = episode === null ? title.available : episode.available;
  const download = useDownloadMenuItem(title, episode?.id ?? null, available);
  const openTitle = useTitlePress(title);

  const resuming =
    episode === null
      ? titleState === "started" && title.kind === "movie"
      : resumeOf(episode.progress) !== null;

  const marks: Marks =
    episode === null
      ? { watched: titleState !== "watched", unwatched: titleState !== null }
      : { watched: episode.progress?.watched !== true, unwatched: episode.progress !== null };

  const episodeId = episode?.id ?? null;

  return (
    <Link.Menu>
      {available ? (
        <Link.MenuAction icon="play.fill" onPress={() => router.push(playHref)}>
          {resuming ? "Resume" : "Play"}
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
      {marks.watched ? (
        <Link.MenuAction
          icon="checkmark.circle"
          onPress={() => void states.markWatched(title, episodeId)}
        >
          Mark as Watched
        </Link.MenuAction>
      ) : null}
      {marks.unwatched ? (
        <Link.MenuAction
          icon="arrow.uturn.backward.circle"
          onPress={() => void states.markUnwatched(title, episodeId)}
        >
          Mark as Unwatched
        </Link.MenuAction>
      ) : null}
      {/* Keyed apart: a native item keeps a subtitle that a later render leaves out. */}
      {download === null ? null : download.subtitle === undefined ? (
        <Link.MenuAction key="download" icon={download.icon} onPress={download.press}>
          {download.title}
        </Link.MenuAction>
      ) : (
        <Link.MenuAction
          key="download-status"
          icon={download.icon}
          subtitle={download.subtitle}
          onPress={download.press}
        >
          {download.title}
        </Link.MenuAction>
      )}
      <Link.MenuAction icon="info.circle" onPress={() => openTitle.onPress()}>
        Go to Title
      </Link.MenuAction>
    </Link.Menu>
  );
};
