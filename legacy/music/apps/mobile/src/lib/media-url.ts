import type { ServerOrigin } from "./server";

const absolute = /^https?:\/\//iu;

const local = /^file:\/\//iu;

/**
 * The absolute URL of artwork on the server at `origin`. Absolute URLs pass through, so a server
 * that names another host for media still works, and so does a downloaded cover's file on this
 * phone; null stays null (no artwork).
 */
export const resolveMediaUrl = (origin: ServerOrigin, url: string | null): string | null => {
  if (url === null || url === "") return null;

  return local.test(url) ? url : mediaUrl(origin, url);
};

/** The absolute URL of a media path that is always present, such as a stream URL. */
export const mediaUrl = (origin: ServerOrigin, url: string): string => {
  if (absolute.test(url)) return url;

  return url.startsWith("/") ? `${origin}${url}` : `${origin}/${url}`;
};
