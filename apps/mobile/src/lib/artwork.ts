import { artworkUrl as mediaArtworkUrl } from "@media/contracts/artwork";
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

/** The image URL for an artwork key, or undefined without one so the slot draws its placeholder. */
export const artworkUrl = (
  mediaUrl: string,
  key: string | null | undefined,
  use: ArtworkUse,
): string | undefined =>
  key === null || key === undefined || key === ""
    ? undefined
    : mediaArtworkUrl(mediaUrl, key, WIDTHS[use]);
