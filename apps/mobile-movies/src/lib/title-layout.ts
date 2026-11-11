import type { WidthClass } from "./layout";

const PHONE_HERO_HEIGHT = 480;

const HERO_SHARE = 0.56;

const HERO_MIN = 480;

const HERO_MAX = 700;

/**
 * How tall a title's hero is, in points: an iPhone's fixed 480, and on an iPad about 56% of the
 * window's height, kept between 480 and 700 so a short window still shows the artwork and a tall
 * one still shows the episodes.
 */
export const heroHeight = (windowHeight: number, widthClass: WidthClass): number =>
  widthClass === "compact"
    ? PHONE_HERO_HEIGHT
    : Math.min(HERO_MAX, Math.max(HERO_MIN, Math.round(windowHeight * HERO_SHARE)));

/** The scroll offsets, in points, across which the title page's top bar fades in. */
export interface FadeRange {
  readonly from: number;
  readonly to: number;
}

const PHONE_BAR_FADE: FadeRange = { from: 150, to: 200 };

const IPAD_TITLE_BLOCK = 280;

const TOP_BAR_HEIGHT = 64;

const FADE_SPAN = 50;

/**
 * Where the top bar fades in: on an iPhone as it always has, and on an iPad once the name at the
 * bottom of a taller hero reaches the bar, so the title never shows twice.
 */
export const topBarFade = (
  heroHeightPoints: number,
  topInset: number,
  widthClass: WidthClass,
): FadeRange => {
  if (widthClass === "compact") return PHONE_BAR_FADE;

  const from = Math.max(0, heroHeightPoints - IPAD_TITLE_BLOCK - TOP_BAR_HEIGHT - topInset);

  return { from, to: from + FADE_SPAN };
};

/** How a show's episodes lay out on its page. */
export type EpisodeLayout =
  /** One full-width row per episode, as on an iPhone. */
  | { readonly kind: "rows" }
  /** Cards with a 16:9 still on top, `columns` to a row, sharing the width inside the gutters. */
  | { readonly kind: "grid"; readonly columns: number };

const EPISODE_COLUMNS = { regular: 2, wide: 3 } as const;

/**
 * The episodes' layout for a window's width class: rows on an iPhone, two columns of cards in an
 * iPad's portrait window, and three in landscape.
 */
export const episodeLayout = (widthClass: WidthClass): EpisodeLayout =>
  widthClass === "compact"
    ? { kind: "rows" }
    : { kind: "grid", columns: EPISODE_COLUMNS[widthClass] };

/** `items` in rows of `columns`, the last row holding what is left. */
export const rowsOf = <Item>(
  items: ReadonlyArray<Item>,
  columns: number,
): ReadonlyArray<ReadonlyArray<Item>> => {
  const rows: Array<ReadonlyArray<Item>> = [];

  for (let start = 0; start < items.length; start += columns) {
    rows.push(items.slice(start, start + columns));
  }

  return rows;
};
