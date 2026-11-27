import { COVER_SIZES, coverSizeFor, sizedArtworkUrl } from "@media/contracts/artwork";

import { MEDIA_BASE_URL } from "@/env";

/**
 * Where the browser loads a cover from: the music commands answer art as a path on the media
 * server with its shareable ticket, which a client prefixes with the media server's address.
 */
export const artSrc = (url: string): string => `${MEDIA_BASE_URL}${url}`;

/**
 * The cover at `url` for a cell drawn `pixels` device pixels big: the server's copy for that size
 * (`coverSizeFor`), or the original.
 */
export const coverSrc = (url: string, pixels: number): string =>
  sizedArtworkUrl(artSrc(url), coverSizeFor(pixels));

/** The smallest copy of a cover, for reading its colors. */
export const smallestArtSrc = (url: string): string => sizedArtworkUrl(artSrc(url), COVER_SIZES[0]);
