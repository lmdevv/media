import { usePlayer } from "@media/player/react";
import { useNavigate } from "@tanstack/react-router";
import { HeartIcon, ListMusicIcon, PlusIcon } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

import { usePlayTracks } from "@/components/library/cards";
import { useUi } from "@/components/shell/ui-state";
import { HOTKEYS } from "@/lib/hotkeys";
import { readPages, useAllRows } from "@/lib/pages";
import { useMe, useMusic, useRead } from "@/lib/platform";
import { useHeld } from "@/lib/use-held";

import { offeredScreens } from "./catalog";
import type { Destination } from "./catalog";
import { browseItems, searchItems } from "./items";
import type { Item } from "./items";

const SHUFFLE_LIMIT = 2000;

/** The menu's rows for the current query. */
interface MenuItems {
  readonly items: ReadonlyArray<Item>;
  /**
   * Whether library results for the query are still loading. While they load, `items` keeps the
   * previous query's library results so the list doesn't flash empty.
   */
  readonly searching: boolean;
}

/**
 * The menu's rows for a query: recent records and actions while it is empty; library results and
 * matching actions once something is typed.
 *
 * @param query - The trimmed, deferred query.
 * @param onClose - Closes the menu; actions call it before they navigate or open something.
 */
export const useMenuItems = (query: string, onClose: () => void): MenuItems => {
  const player = usePlayer();
  const { openNewPlaylist, setNowPlaying } = useUi();
  const navigate = useNavigate();
  const music = useMusic();
  const me = useMe();
  const home = useRead(music.library.home, {});
  const playlists = useAllRows(music.playlists.list, (paginationOpts) => ({ paginationOpts }));
  const playTracks = usePlayTracks();
  const search = useRead(music.library.search, query.length === 0 ? "skip" : { query, limit: 6 });
  const role = me?.role ?? "guest";

  const results = useHeld(search);
  const hasTrack = player.track !== null;

  const actions = useMemo((): ReadonlyArray<Item> => {
    const go = (destination: Destination) => () => {
      onClose();

      if (destination.kind === "account") window.location.assign(destination.href);
      else void navigate({ to: destination.to });
    };

    const quick: Array<Item> = [
      {
        kind: "action",
        id: "shuffle-liked",
        section: "Commands",
        title: "Shuffle liked songs",
        detail: "Play your liked songs in random order",
        icon: HeartIcon,
        label: "Shuffle",
        run: () => {
          onClose();

          const liked = readPages(
            (paginationOpts) => music.likes.list({ paginationOpts }),
            SHUFFLE_LIMIT,
          ).then((tracks) => {
            if (tracks.length === 0) toast("You haven't liked any songs yet.");

            return tracks;
          });

          void playTracks(liked, { shuffle: true });
        },
      },
      {
        kind: "action",
        id: "new-playlist",
        section: "Commands",
        title: "New playlist",
        detail: "Create a playlist, empty or from the queue or liked songs",
        icon: PlusIcon,
        shortcut: HOTKEYS["playlists.new"].defaultHotkey,
        label: "Create",
        run: () => {
          onClose();
          openNewPlaylist();
        },
      },
    ];

    if (hasTrack) {
      quick.push({
        kind: "action",
        id: "open-queue",
        section: "Commands",
        title: "Open the queue",
        detail: "See and change what plays next",
        icon: ListMusicIcon,
        label: "Open",
        run: () => {
          onClose();
          setNowPlaying("queue");
        },
      });
    }

    const screens = offeredScreens(role).map((screen): Item => ({
      kind: "action",
      id: `go-${screen.name}`,
      section: "Go to",
      title: screen.title,
      detail: `Open ${screen.title}`,
      keywords: screen.name,
      icon: screen.icon,
      label: "Open",
      run: go(screen.destination),
    }));

    return [...quick, ...screens];
  }, [role, navigate, onClose, hasTrack, playTracks, music, openNewPlaylist, setNowPlaying]);

  const items = useMemo(
    (): ReadonlyArray<Item> =>
      query.length === 0
        ? browseItems({
            track: player.track,
            playlists: playlists ?? [],
            recentlyPlayed: home?.recentlyPlayed ?? [],
            actions,
          })
        : searchItems({ query, results, playlists: playlists ?? [], actions }),
    [query, player.track, playlists, home, actions, results],
  );

  return { items, searching: query.length > 0 && search === undefined };
};
