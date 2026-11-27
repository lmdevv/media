import { artworkCacheKey, coverSizeFor, sizedArtworkUrl } from "@media/contracts/artwork";

const absolute = /^https?:\/\//iu;

const local = /^file:\/\//iu;

/**
 * The absolute URL of artwork on the server at `origin`. Absolute URLs pass through, so a server
 * that names another host for media still works, and so does a downloaded cover's file on this
 * phone; null stays null (no artwork).
 */
export const resolveMediaUrl = (origin: string, url: string | null): string | null => {
  if (url === null || url === "") return null;

  return local.test(url) ? url : mediaUrl(origin, url);
};

/** The absolute URL of a media path that is always present, such as a stream URL. */
const mediaUrl = (origin: string, url: string): string => {
  if (absolute.test(url)) return url;

  return url.startsWith("/") ? `${origin}${url}` : `${origin}/${url}`;
};

/** An image to load, and the key the image cache keeps it under. */
export interface ArtSource {
  readonly uri: string;
  readonly cacheKey: string;
}

/**
 * The cover to load for `url` (as `resolveMediaUrl` reads it) drawn `size` device pixels wide: the
 * server's copy for that size (`coverSizeFor`), or the stored original. The cache keeps it under
 * its URL without the weekly image ticket, so a new ticket loads nothing again, and each size under
 * its own key. A cover saved on this phone loads as it is.
 */
export const artSource = (
  origin: string,
  url: string | null,
  size: number | "original",
): ArtSource | null => {
  const resolved = resolveMediaUrl(origin, url);

  if (resolved === null) return null;

  const uri =
    size === "original" || local.test(resolved)
      ? resolved
      : sizedArtworkUrl(resolved, coverSizeFor(size));

  return { uri, cacheKey: artworkCacheKey(uri) };
};
