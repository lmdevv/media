import type { TrackId } from "@music/commands/ids";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { chooseSurface } from "@/components/player/play-on";
import type { PlayOnSurface } from "@/components/player/play-on";
import { isDesktopNow } from "@/lib/use-media";

/** Which full-screen Now Playing view is open, if any. */
export type NowPlayingView = "player" | "queue" | "cover";

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

  // Stable, so the speaker button's mount effect runs once, not on every UI state change.
  const setPlayOnPopoverMounted = useCallback((mounted: boolean) => {
    setPopoverMounted(mounted);

    if (!mounted) setPlayOn((opened) => (opened === "popover" ? null : opened));
  }, []);

  // Now Playing covers the player bar on desktop, so a "Play on" popover open under it closes.
  const setNowPlaying = useCallback((view: NowPlayingView | null) => {
    setNowPlayingView(view);

    if (view !== null) setPlayOn((opened) => (opened === "popover" ? null : opened));
  }, []);

  const value = useMemo(
    (): UiState => ({
      nowPlaying,
      setNowPlaying,
      queueOpen,
      setQueueOpen,
      commandOpen,
      setCommandOpen,
      playOn,
      openPlayOn: () =>
        setPlayOn(
          chooseSurface({
            desktop: isDesktopNow(),
            popoverMounted: playOnPopoverMounted,
            nowPlayingOpen: nowPlaying !== null,
          }),
        ),
      closePlayOn: () => setPlayOn(null),
      setPlayOnPopoverMounted,
      jamOpen,
      setJamOpen,
      newPlaylist,
      openNewPlaylist: (trackIds = []) => setNewPlaylist({ trackIds }),
      closeNewPlaylist: () => setNewPlaylist(null),
    }),
    [
      nowPlaying,
      queueOpen,
      commandOpen,
      playOn,
      playOnPopoverMounted,
      setPlayOnPopoverMounted,
      setNowPlaying,
      jamOpen,
      newPlaylist,
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
