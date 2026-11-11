import type { ArtworkWidth } from "@media/contracts/artwork";

// An iPad's billboard is up to 2752 pixels wide, past the largest resize, so it takes the original.
const WIDTHS = {
  thumb: 185,
  poster: 342,
  card: 780,
  backdrop: 1280,
  billboard: undefined,
} as const satisfies Record<string, ArtworkWidth | undefined>;

/** Where an image is drawn, which decides the width it is fetched at. */
export type ArtworkUse = keyof typeof WIDTHS;

/**
 * The image URL for an artwork path on the media server at `mediaUrl`, resized for `use`, or
 * undefined without one so the slot draws its placeholder. A path is what the core hands out in
 * place of an artwork key, `/artwork/<key>?ticket=<ticket>`, with its shareable ticket (ADR 0011).
 */
export const artworkUrl = (
  mediaUrl: string,
  path: string | null | undefined,
  use: ArtworkUse,
): string | undefined => {
  if (path === null || path === undefined || path === "") return undefined;

  const width = WIDTHS[use];

  if (width === undefined) return `${mediaUrl}${path}`;

  return `${mediaUrl}${path}${path.includes("?") ? "&" : "?"}w=${String(width)}`;
};
