/** The shell's hold on the Now Playing panel. Nothing here follows the position, so it re-renders by song. */
import type { TrackId } from "@music/commands/ids";
import type { LyricsAnswer, LyricsOffer } from "@music/player/lyrics";
import { useNavigationState } from "expo-router/react-navigation";
import { useState } from "react";

import { useSongLyrics } from "@/components/playback/use-song-lyrics";
import { INSPECTOR_START, pickTab, pressPanel, setOpen, shownTab } from "@/lib/inspector";
import type { InspectorPlacement, InspectorTab } from "@/lib/inspector";
import type { Panel } from "@/lib/now-playing-layout";
import { tabsAreCovered } from "@/lib/shell-layout";
import type { ShellLayout } from "@/lib/shell-layout";

/** The panel as the frame, the bar, and the panel itself read and change it. */
export interface Inspector {
  /** Where it sits at this window size, or null where the frame has no panel. */
  readonly placement: InspectorPlacement | null;
  readonly open: boolean;
  readonly tab: InspectorTab;
  readonly lyrics: LyricsAnswer;
  readonly offer: LyricsOffer;
  /**
   * Whether a page or Now Playing is over the tabs. The panel keeps its body, scroll, and swiped
   * rows under it, since Now Playing is see-through as it drags down, and only pauses the lyrics'
   * frame loop.
   */
  readonly covered: boolean;
  readonly pick: (tab: InspectorTab) => void;
  readonly pressPanel: (panel: Panel) => void;
  readonly hide: () => void;
}

/** The panel for the frame's `placement`, for the song `trackId`. */
export const useInspector = (
  placement: ShellLayout["inspector"],
  trackId: TrackId | null,
): Inspector => {
  const [state, setState] = useState(INSPECTOR_START);
  const at = placement === "none" ? null : placement;
  const { lyrics, offer, fallback } = useSongLyrics(at === null ? null : trackId);
  const covered = useNavigationState(tabsAreCovered);
  const tab = shownTab(state.picked, offer, fallback);

  return {
    placement: at,
    open: at !== null && state.open[at],
    tab,
    lyrics,
    offer,
    covered,
    pick: (next) => {
      setState((current) => pickTab(current, next));
    },
    pressPanel: (panel) => {
      if (at !== null) setState((current) => pressPanel(current, at, tab, panel));
    },
    hide: () => {
      if (at !== null) setState((current) => setOpen(current, at, false));
    },
  };
};
