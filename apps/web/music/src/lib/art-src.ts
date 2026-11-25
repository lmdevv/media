import { ARTWORK_WIDTHS, sizedArtworkUrl } from "@media/contracts/artwork";

import { MEDIA_BASE_URL } from "@/env";

/**
 * Where the browser loads a cover from: the music commands answer art as a path on the media
 * server with its shareable ticket, which a client prefixes with the media server's address.
 */
export const artSrc = (url: string): string => `${MEDIA_BASE_URL}${url}`;

/**
 * Every resized copy of a cover by its width, an `<img srcset>` the browser picks from by the size
 * the image is drawn at.
 */
export const artSrcSet = (url: string): string =>
  ARTWORK_WIDTHS.map((width) => `${sizedArtworkUrl(artSrc(url), width)} ${String(width)}w`).join(
    ", ",
  );

/** The smallest copy of a cover, for reading its colors. */
export const smallestArtSrc = (url: string): string =>
  sizedArtworkUrl(artSrc(url), ARTWORK_WIDTHS[0]);
