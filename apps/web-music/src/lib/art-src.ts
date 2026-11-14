import { MEDIA_BASE_URL } from "@/env";

/**
 * Where the browser loads a cover from: the music commands answer art as a path on the media
 * server with its shareable ticket, which a client prefixes with the media server's address.
 */
export const artSrc = (url: string): string => `${MEDIA_BASE_URL}${url}`;
