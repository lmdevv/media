/**
 * How Now Playing is presented on each device, and what it shows at each window width (Paper page
 * 25). On a phone (B01) and in the iPad's single column (P07) the queue (B03) and the lyrics (B12)
 * open in place of the cover. In a `wide` window on its side (P08, P09) the cover stays, and a
 * side pane beside the player holds one of the two: the one the person opened, else the lyrics
 * when the song has them, else the queue. One stage view serves every width, so rotating or
 * resizing keeps what the person opened.
 */
import { lyricsButton } from "@music/player/lyrics";
import type { LyricsOffer } from "@music/player/lyrics";

import type { DeviceFamily } from "./device-family";
import type { WidthClass } from "./layout";

/**
 * How Now Playing is presented: the iPhone's native `sheet`, which the system drags down (B11), or
 * over the whole `window` (P07), which the app drags down itself.
 */
export type NowPlayingPresentation = "sheet" | "window";

/**
 * The presentation on a device. An iPad keeps the window at every width, even a phone-wide Split
 * View, so resizing it while Now Playing is open never has to swap how it is presented.
 */
export const presentationOf = (family: DeviceFamily): NowPlayingPresentation =>
  family === "iPad" ? "window" : "sheet";

/** What opens in place of the cover, or shows in the side pane. */
export type Panel = "queue" | "lyrics";

/**
 * What the person opened: the cover, or a panel. Closed, `panel` is the one still closing, kept
 * until the cover is back so it can animate, then null, so nothing in it (the lyrics' frame loop)
 * runs behind the cover.
 */
export type StageView =
  | { readonly open: false; readonly panel: Panel | null }
  | { readonly open: true; readonly panel: Panel };

/** The cover, with nothing open or closing. */
export const CLOSED: StageView = { open: false, panel: null };

/** What Now Playing opens on: the panel a link names, such as the player bar's queue, or the cover. */
export const openingView = (panel: string | string[] | undefined): StageView =>
  panel === "queue" || panel === "lyrics" ? { open: true, panel } : CLOSED;

/**
 * Now Playing's layout: the iPhone's native `sheet`; a centered `column`, which fills the iPad's
 * window at any width; or `split`, the player beside the side pane.
 */
export type NowPlayingLayout = "sheet" | "column" | "split";

/**
 * The layout for a presentation and the window it fills: two panes only when the window is `wide`
 * and on its side, since a 13-inch iPad in portrait is wide enough but leaves the panes short
 * beside a tall empty space.
 */
export const layoutOf = (
  presentation: NowPlayingPresentation,
  widthClass: WidthClass,
  landscape: boolean,
): NowPlayingLayout => {
  if (presentation === "sheet") return "sheet";

  return widthClass === "wide" && landscape ? "split" : "column";
};

/**
 * The side pane's panel before the person picks one: the lyrics when the song has words to read,
 * else the queue. While the lookup runs it keeps the `previous` answer's panel, so the pane doesn't
 * flip to the lyrics and back on every new song, and before the first answer it is null, so
 * opening on a song with lyrics doesn't show the queue first.
 */
export const defaultPanel = (offer: LyricsOffer, previous: Panel | null): Panel | null => {
  if (offer === "loading") return previous;

  return offer === "ready" ? "lyrics" : "queue";
};

/** What Now Playing renders for a stage view at one layout. */
export interface NowPlayingParts {
  /** What the player's stage shows in place: the stage view, or the cover beside a pane. */
  readonly stage: StageView;
  /**
   * Whether the stage follows the morph. It holds the cover still where it shows the cover over
   * an open view: beside the side pane, and over lyrics the song lacks.
   */
  readonly morphs: boolean;
  /** The side pane's panel; null with no side pane, or while it waits for the first answer. */
  readonly side: Panel | null;
  /** Whether the controls fold the volume and the bottom row away for the lyrics (B12). */
  readonly folds: boolean;
  /** Where the lyrics open from: the chip on the cover, or a button in the bottom row (P08). */
  readonly lyricsFrom: "cover" | "row";
  /** The panel the bottom row highlights, if any. */
  readonly selected: Panel | null;
}

/**
 * What renders at `layout` for `view`, for a song whose lyrics are `offer`. The side pane shows
 * `fallback` until the person picks a panel, and when they picked the lyrics of a song that has
 * none, rather than an empty pane behind a dimmed button. For the same song the iPad's column
 * shows the cover, so rotating from that fallback doesn't open an empty panel in its place; the
 * phone keeps the lyrics open to say there are none.
 */
export const partsOf = (
  layout: NowPlayingLayout,
  view: StageView,
  offer: LyricsOffer,
  fallback: Panel | null,
): NowPlayingParts => {
  const missing = view.open && view.panel === "lyrics" && lyricsButton(offer, false).disabled;

  if (layout === "split") {
    const side = view.open && !missing ? view.panel : fallback;

    return { stage: CLOSED, morphs: false, side, folds: false, lyricsFrom: "row", selected: side };
  }

  const cover = layout === "column" && missing;
  const stage = cover ? CLOSED : view;

  return {
    stage,
    morphs: !cover,
    side: null,
    folds: stage.panel === "lyrics",
    lyricsFrom: "cover",
    selected: stage.open ? stage.panel : null,
  };
};

/**
 * What pressing the bottom row's button for `panel` opens: in place it opens the panel or closes
 * it again; the side pane switches to it and never empties.
 */
export const pressedPanel = (
  layout: NowPlayingLayout,
  view: StageView,
  panel: Panel,
): Panel | null => {
  if (layout === "split") return panel;

  return view.open && view.panel === panel ? null : panel;
};
