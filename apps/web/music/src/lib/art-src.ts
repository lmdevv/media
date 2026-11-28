import { COVER_SIZES, sizedArtworkUrl } from "@media/contracts/artwork";

import { MEDIA_BASE_URL } from "@/env";

import { webCoverSize } from "./cover-size";

/**
 * Where the browser loads a cover from: the music commands answer art as a path on the media
 * server with its shareable ticket, which a client prefixes with the media server's address.
 */
export const artSrc = (url: string): string => `${MEDIA_BASE_URL}${url}`;

/**
 * The cover at `url` for a cell drawn `pixels` device pixels big: the copy `webCoverSize` picks, or
 * the original.
 */
export const coverSrc = (url: string, pixels: number): string =>
  sizedArtworkUrl(artSrc(url), webCoverSize(pixels));

/** The smallest copy of a cover, for reading its colors. */
export const smallestArtSrc = (url: string): string => sizedArtworkUrl(artSrc(url), COVER_SIZES[0]);
