import type { TrackId } from "@music/commands/ids";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { chooseSurface } from "@/components/player/play-on";
import type { PlayOnSurface } from "@/components/player/play-on";
import { isDesktopNow } from "@/lib/use-media";

/**
 * Which full-screen Now Playing view is open, if any: `player` is the cover on desktop and the full
 * player on phones, `queue` adds the queue, and `lyrics` the playing song's lyrics.
 */
export type NowPlayingView = "player" | "queue" | "lyrics";

/** App-wide UI state that several screens open or close. */
export interface UiState {
  readonly nowPlaying: NowPlayingView | null;
  readonly setNowPlaying: (view: NowPlayingView | null) => void;
  /** The desktop queue panel beside the main column. */
  readonly queueOpen: boolean;
  readonly setQueueOpen: (open: boolean) => void;
  readonly commandOpen: boolean;
  readonly setCommandOpen: (open: boolean) => void;
  /** The surface "Play on" opened on, kept until the user closes it; null while closed. */
  readonly playOn: PlayOnSurface | null;
  /** Opens "Play on" on the surface that fits the layout now. */
  readonly openPlayOn: () => void;
  readonly closePlayOn: () => void;
  /**
   * The player bar's speaker button mounted (so desktop can open "Play on" as its popover) or went
   * away, which closes its open popover.
   */
  readonly setPlayOnPopoverMounted: (mounted: boolean) => void;
  /** The Jam panel: start, share, and run a Jam, or see the one you're in. */
  readonly jamOpen: boolean;
  readonly setJamOpen: (open: boolean) => void;
  /** Open with the songs a new playlist starts with; null when the dialog is closed. */
  readonly newPlaylist: { readonly trackIds: ReadonlyArray<TrackId> } | null;
  readonly openNewPlaylist: (trackIds?: ReadonlyArray<TrackId>) => void;
  readonly closeNewPlaylist: () => void;
}

const UiContext = createContext<UiState | null>(null);

/** Holds {@link UiState} for the signed-in app. */
export function UiStateProvider({ children }: { readonly children: ReactNode }) {
  const [nowPlaying, setNowPlayingView] = useState<NowPlayingView | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [playOn, setPlayOn] = useState<PlayOnSurface | null>(null);
  const [playOnPopoverMounted, setPopoverMounted] = useState(false);
  const [jamOpen, setJamOpen] = useState(false);
  const [newPlaylist, setNewPlaylist] = useState<UiState["newPlaylist"]>(null);

  const setPlayOnPopoverMounted = useCallback((mounted: boolean) => {
    setPopoverMounted(mounted);

    if (!mounted) setPlayOn((opened) => (opened === "popover" ? null : opened));
  }, []);

  const setNowPlaying = useCallback((view: NowPlayingView | null) => {
    setNowPlayingView(view);

    if (view !== null) setPlayOn((opened) => (opened === "popover" ? null : opened));
  }, []);

  const surface = useRef({ playOnPopoverMounted, nowPlayingOpen: nowPlaying !== null });

  useLayoutEffect(() => {
    surface.current = { playOnPopoverMounted, nowPlayingOpen: nowPlaying !== null };
  }, [playOnPopoverMounted, nowPlaying]);

  const openPlayOn = useCallback(() => {
    setPlayOn(
      chooseSurface({
        desktop: isDesktopNow(),
        popoverMounted: surface.current.playOnPopoverMounted,
        nowPlayingOpen: surface.current.nowPlayingOpen,
      }),
    );
  }, []);

  const closePlayOn = useCallback(() => setPlayOn(null), []);

  const openNewPlaylist = useCallback(
    (trackIds: ReadonlyArray<TrackId> = []) => setNewPlaylist({ trackIds }),
    [],
  );

  const closeNewPlaylist = useCallback(() => setNewPlaylist(null), []);

  const value = useMemo(
    (): UiState => ({
      nowPlaying,
      setNowPlaying,
      queueOpen,
      setQueueOpen,
      commandOpen,
      setCommandOpen,
      playOn,
      openPlayOn,
      closePlayOn,
      setPlayOnPopoverMounted,
      jamOpen,
      setJamOpen,
      newPlaylist,
      openNewPlaylist,
      closeNewPlaylist,
    }),
    [
      nowPlaying,
      queueOpen,
      commandOpen,
      playOn,
      openPlayOn,
      closePlayOn,
      setPlayOnPopoverMounted,
      setNowPlaying,
      jamOpen,
      newPlaylist,
      openNewPlaylist,
      closeNewPlaylist,
    ],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

/** The app-wide {@link UiState}. Must be inside `UiStateProvider`. */
export const useUi = (): UiState => {
  const state = useContext(UiContext);

  if (state === null) throw new Error("useUi must be used inside UiStateProvider");

  return state;
};
