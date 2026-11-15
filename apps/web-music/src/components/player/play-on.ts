/**
 * Where "Play on" shows: the player bar's popover on desktop, a dialog on desktop while the bar
 * has no speaker button (nothing loaded) or Now Playing covers it, and the sheet below the desktop
 * width.
 */
export type PlayOnSurface = "popover" | "dialog" | "sheet";

/** What decides the surface when "Play on" opens. */
export interface PlayOnLayout {
  readonly desktop: boolean;
  /** The player bar's speaker button is mounted. */
  readonly popoverMounted: boolean;
  /** The full-screen Now Playing is open, covering the player bar on desktop. */
  readonly nowPlayingOpen: boolean;
}

/** The surface a newly opened "Play on" uses; it keeps it until the user closes it. */
export const chooseSurface = ({
  desktop,
  popoverMounted,
  nowPlayingOpen,
}: PlayOnLayout): PlayOnSurface => {
  if (!desktop) return "sheet";

  return popoverMounted && !nowPlayingOpen ? "popover" : "dialog";
};

/**
 * The surface to show for an open "Play on" at the current width. There is only ever one across
 * the phone/desktop breakpoint (ADS-106): phones show the sheet, and desktop shows what was
 * opened, with a sheet opened on a phone showing as the dialog. A popover never outlives its
 * button: `setPlayOnPopoverMounted(false)` in the UI state closes it.
 */
export const shownSurface = (
  opened: PlayOnSurface | null,
  desktop: boolean,
): PlayOnSurface | null => {
  if (opened === null) return null;

  if (!desktop) return "sheet";

  return opened === "sheet" ? "dialog" : opened;
};
