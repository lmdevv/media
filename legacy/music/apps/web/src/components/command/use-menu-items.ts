import { offeredCommands } from "@music/commands/forms";
import { usePlayer } from "@music/player/react";
import { useRead, useReadOnce } from "@music/sdk/react";
import { useNavigate } from "@tanstack/react-router";
import { HeartIcon, ListMusicIcon, PlusIcon, SpeakerIcon } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

import { usePlayTracks } from "@/components/library/cards";
import { useUi } from "@/components/shell/ui-state";
import { toastFailure } from "@/lib/action";
import { readPages } from "@/lib/read-pages";
import { useHeld } from "@/lib/use-held";

import { offeredScreens } from "./catalog";
import type { Route } from "./catalog";
import { browseItems, cliOf, searchItems } from "./items";
import type { Item } from "./items";

/** Most liked songs "Shuffle liked songs" reads; the queue keeps 1,000 of them. */
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
 * The menu's rows for a query: recent records, actions, and commands while it is empty; library
 * results and matching actions and commands once something is typed.
 *
 * @param query - The trimmed, deferred query.
 * @param onClose - Closes the menu; actions call it before they navigate or open something.
 */
export const useMenuItems = (query: string, onClose: () => void): MenuItems => {
  const player = usePlayer();
  const { openPlayOn, openNewPlaylist, setNowPlaying } = useUi();
  const navigate = useNavigate();
  const me = useRead("account.me", {});
  const home = useRead("library.home", {});
  const playlists = useRead("playlists.list", {});
  const readLikes = useReadOnce("likes.page");
  const playTracks = usePlayTracks();
  const search = useRead("search", query.length === 0 ? "skip" : { query, limit: 6 });
  // Until the account loads, offer only what everyone may do.
  const role = me?.role ?? "guest";

  // While a new query loads, the previous results stay on screen.
  const results = useHeld(search);
  // The actions only change with whether something plays, not with each queue or position update.
  const hasTrack = player.track !== null;

  const actions = useMemo((): ReadonlyArray<Item> => {
    const go = (to: Route) => () => {
      onClose();
      void navigate({ to });
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
          void (async () => {
            try {
              const tracks = await readPages(
                (cursor) => readLikes({ cursor, limit: 200 }),
                SHUFFLE_LIMIT,
              );

              if (tracks.length === 0) toast("You haven't liked any songs yet.");
              else await playTracks(tracks, { shuffle: true });
            } catch (cause) {
              toastFailure(cause);
            }
          })();
        },
      },
      {
        kind: "action",
        id: "devices",
        section: "Commands",
        title: "Play on another device…",
        detail: "Move playback to your phone, another browser, or a speaker",
        icon: SpeakerIcon,
        shortcut: "D",
        label: "Choose",
        run: () => {
          onClose();
          openPlayOn();
        },
      },
      {
        kind: "action",
        id: "new-playlist",
        section: "Commands",
        title: "New playlist",
        detail: "Create a playlist, empty or from the queue or liked songs",
        icon: PlusIcon,
        shortcut: "N",
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
      detail: `Open ${screen.title} · ${cliOf(screen.name)}`,
      icon: screen.icon,
      label: "Open",
      run: go(screen.to),
    }));

    const registry = offeredCommands({ role, playing: hasTrack }).map(({ name, fields }): Item => ({
      kind: "command",
      id: `cmd-${name}`,
      section: "Commands",
      name,
      fields,
    }));

    return [...quick, ...registry, ...screens];
  }, [
    role,
    navigate,
    onClose,
    hasTrack,
    playTracks,
    readLikes,
    openPlayOn,
    openNewPlaylist,
    setNowPlaying,
  ]);

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
