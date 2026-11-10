/**
 * Artwork URLs. Titles, seasons, and episodes carry artwork keys (`Artwork.poster`,
 * `Season.poster`, `Episode.still`, and so on): opaque, URL-safe strings the media service minted
 * while scanning. Clients load an image from `${mediaBaseUrl}/artwork/${key}`, optionally resized
 * to one of `ARTWORK_WIDTHS` with `?w=`. On old movies images need no token, so `<img>` tags can
 * use the URL as is; on the core an image URL also carries a shareable `ticket` for the key's
 * `artworkTicketId`, the same string for a whole week, so images still cache (ADR 0011).
 */
import { Schema } from "effect";

/** Widths the media service resizes artwork to. Other widths are refused. */
export const ARTWORK_WIDTHS = [185, 342, 500, 780, 1280] as const;

/** A width the media service resizes artwork to. */
export const ArtworkWidth = Schema.Literals(ARTWORK_WIDTHS);

/** A width the media service resizes artwork to. */
export type ArtworkWidth = typeof ArtworkWidth.Type;

/** An artwork key as the media service mints it: a version prefix and a sealed reference. */
export const ArtworkKey = Schema.String.check(
  Schema.isPattern(/^a1\.[\w-]+$/u),
  Schema.isMaxLength(2048),
).pipe(Schema.brand("ArtworkKey"));

/** An artwork key as titles carry it. */
export type ArtworkKey = typeof ArtworkKey.Type;

/**
 * The URL of an artwork image. `mediaBaseUrl` is the media service's base URL, such as the
 * `mediaBaseUrl` of a started playback or the web app's configured media URL.
 *
 * @param width - Resize to this width, keeping the aspect ratio; the original when absent.
 */
export const artworkUrl = (mediaBaseUrl: string, key: string, width?: ArtworkWidth): string => {
  const base = `${mediaBaseUrl.replace(/\/+$/u, "")}/artwork/${encodeURIComponent(key)}`;

  return width === undefined ? base : `${base}?w=${String(width)}`;
};

/**
 * The id a shareable ticket names for the artwork at `key` (ADR 0011): the unpadded base64url of
 * the key's SHA-256, 43 characters, since a key can be longer than a ticket's resource id allows.
 * The core issues tickets for this id, and the server's artwork route admits them for it.
 */
export const artworkTicketId = async (key: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));

  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};
