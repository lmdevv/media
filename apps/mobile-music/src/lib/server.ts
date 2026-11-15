import { normalizeServerUrl } from "@media/mobile-core/server";

const SCHEME = /^[a-z][a-z\d+.-]*:\/\//iu;

export const displayHost = (url: string): string => url.replace(SCHEME, "");

/**
 * Whether a link's server, as typed (possibly without a scheme), is the one at `mediaUrl`: the
 * same address once normalized, over `https` or, for a link without a scheme, `http`.
 */
export const sameServer = (linked: string, mediaUrl: string): boolean => {
  const normalized = normalizeServerUrl(linked);

  if (normalized === null) return false;

  return SCHEME.test(linked.trim())
    ? normalized === mediaUrl
    : normalized === mediaUrl || normalized.replace(/^https:/u, "http:") === mediaUrl;
};
