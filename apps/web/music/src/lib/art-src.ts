import { ARTWORK_WIDTHS, coverSrcSet, sizedArtworkUrl } from "@media/contracts/artwork";

import { MEDIA_BASE_URL } from "@/env";

/**
 * Where the browser loads a cover from: the music commands answer art as a path on the media
 * server with its shareable ticket, which a client prefixes with the media server's address.
 */
export const artSrc = (url: string): string => `${MEDIA_BASE_URL}${url}`;

/** Every resized copy of a cover and the original, for `<img srcset>` (`coverSrcSet`). */
export const artSrcSet = (url: string): string => coverSrcSet(artSrc(url));

/** The smallest copy of a cover, for reading its colors. */
export const smallestArtSrc = (url: string): string =>
  sizedArtworkUrl(artSrc(url), ARTWORK_WIDTHS[0]);
