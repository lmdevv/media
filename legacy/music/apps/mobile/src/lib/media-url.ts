/**
 * Media URLs from the server (artwork, streams) come back relative to its origin, such as
 * `/media/art/<id>?sig=…`, because the image serves them from the same address people type.
 */
import type { ServerOrigin } from "./server";

const absolute = /^https?:\/\//iu;

/**
 * The absolute URL of a media path on the server at `origin`. Absolute URLs pass through, so a
 * server that names another host for media still works; null stays null (no artwork).
 */
export const resolveMediaUrl = (origin: ServerOrigin, url: string | null): string | null =>
  url === null || url === "" ? null : mediaUrl(origin, url);

/** The absolute URL of a media path that is always present, such as a stream URL. */
export const mediaUrl = (origin: ServerOrigin, url: string): string => {
  if (absolute.test(url)) return url;

  return url.startsWith("/") ? `${origin}${url}` : `${origin}/${url}`;
};
