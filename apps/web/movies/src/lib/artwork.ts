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
 * The URL of an artwork path on the media service, resized for `use`; undefined when a title has
 * no such artwork, so cards draw their blank placeholder. A path is what the core hands out in
 * place of an artwork key, `/artwork/<key>?ticket=<ticket>`, with its shareable ticket (ADR 0011).
 */
export const artworkUrl = (path: string | null, use: ArtworkUse): string | undefined => {
  if (path === null || path === "") return undefined;

  const separator = path.includes("?") ? "&" : "?";

  return `${MEDIA_BASE_URL}${path}${separator}w=${String(WIDTHS[use])}`;
};
