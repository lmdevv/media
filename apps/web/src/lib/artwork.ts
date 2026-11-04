import { artworkUrl as mediaArtworkUrl } from "@media/contracts/artwork";
import type { ArtworkWidth } from "@media/contracts/artwork";

import { MEDIA_BASE_URL } from "@/env";

const WIDTHS = {
  thumb: 185,
  poster: 500,
  card: 780,
  backdrop: 1280,
} as const satisfies Record<string, ArtworkWidth>;

/** Where an image is drawn, which decides the width it is fetched at. */
export type ArtworkUse = keyof typeof WIDTHS;

/**
 * The URL of an artwork key on the media service, resized for `use`; undefined when a title has no
 * such artwork, so cards draw their blank placeholder.
 */
export const artworkUrl = (key: string | null, use: ArtworkUse): string | undefined =>
  key === null || key === "" ? undefined : mediaArtworkUrl(MEDIA_BASE_URL, key, WIDTHS[use]);
