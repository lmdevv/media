import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { TrackId } from "@/lib/models";

/**
 * Which full-screen Now Playing view is open, if any: `player` is the cover on desktop and the full
 * player on phones, `queue` adds the queue, and `lyrics` the playing song's lyrics.
 */
export type NowPlayingView = "player" | "queue" | "lyrics";

/**
 * App-wide UI state that several screens open or close. Old music's "Play on" and Jam surfaces
 * come back with Connect and group sessions (p6).
 */
export interface UiState {
  readonly nowPlaying: NowPlayingView | null;
  readonly setNowPlaying: (view: NowPlayingView | null) => void;
  /** The desktop queue panel beside the main column. */
  readonly queueOpen: boolean;
  readonly setQueueOpen: (open: boolean) => void;
  readonly commandOpen: boolean;
  readonly setCommandOpen: (open: boolean) => void;
  /** Open with the songs a new playlist starts with; null when the dialog is closed. */
  readonly newPlaylist: { readonly trackIds: ReadonlyArray<TrackId> } | null;
  readonly openNewPlaylist: (trackIds?: ReadonlyArray<TrackId>) => void;
  readonly closeNewPlaylist: () => void;
}

const UiContext = createContext<UiState | null>(null);

/** Holds {@link UiState} for the signed-in app. */
export function UiStateProvider({ children }: { readonly children: ReactNode }) {
  const [nowPlaying, setNowPlaying] = useState<NowPlayingView | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [newPlaylist, setNewPlaylist] = useState<UiState["newPlaylist"]>(null);

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
      newPlaylist,
      openNewPlaylist,
      closeNewPlaylist,
    }),
    [nowPlaying, queueOpen, commandOpen, newPlaylist, openNewPlaylist, closeNewPlaylist],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

/** The app-wide {@link UiState}. Must be inside `UiStateProvider`. */
export const useUi = (): UiState => {
  const state = useContext(UiContext);

  if (state === null) throw new Error("useUi must be used inside UiStateProvider");

  return state;
};
