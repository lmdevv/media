/**
 * Artwork URLs. Titles, seasons, and episodes carry artwork keys (`Artwork.poster`,
 * `Season.poster`, `Episode.still`, and so on): opaque, URL-safe strings the media service minted
 * while scanning. Clients load an image from `${mediaBaseUrl}/artwork/${key}`, and a music cover
 * from the path the music commands answer (`/music/art/<hash>`). Either can be resized to one of
 * `ARTWORK_WIDTHS` with `?w=`: artwork by its width, and a music cover, which clients draw as a
 * square crop, by its shorter side. Neither is enlarged. An image URL also carries a shareable `ticket` for the key's
 * `artworkTicketId` (`@media/contracts/ticket`), the same string for a whole week, so images still
 * cache (ADR 0011).
 */
import { Option, Result, Schema } from "effect";

import { TICKET_PARAM } from "./ticket";

/**
 * Widths the media service resizes artwork and music covers to. Other widths are refused, so the
 * service keeps at most this many resized copies of each image.
 */
export const ARTWORK_WIDTHS = [185, 342, 500, 780, 1280] as const;

/** A width the media service resizes artwork to. */
export const ArtworkWidth = Schema.Literals(ARTWORK_WIDTHS);

/** A width the media service resizes artwork to. */
export type ArtworkWidth = typeof ArtworkWidth.Type;

/** The query parameter an image URL asks for a resized image with. */
export const ARTWORK_WIDTH_PARAM = "w";

const decodeWidth = Schema.decodeUnknownOption(
  Schema.FiniteFromString.pipe(Schema.decodeTo(ArtworkWidth)),
);

/**
 * The width to ask for a music cover drawn `pixels` wide: the smallest one that covers it, so the
 * cover is never soft, or undefined when only the original does. The server bounds a cover's
 * shorter side by the width, so the copy covers a frame of that size whatever the cover's shape.
 *
 * @param pixels - The drawn size in device pixels, the longer side of the image's frame in points
 *   times the screen's pixel density, since a cover fills its frame.
 */
export const artworkWidthFor = (pixels: number): ArtworkWidth | undefined =>
  ARTWORK_WIDTHS.find((width) => width >= pixels);

/** `url` asking for `width`, or `url` unchanged for the original. */
export const sizedArtworkUrl = (url: string, width: ArtworkWidth | undefined): string =>
  width === undefined
    ? url
    : `${url}${url.includes("?") ? "&" : "?"}${ARTWORK_WIDTH_PARAM}=${String(width)}`;

/**
 * The key an image cache keeps a media-server image under: its URL without the shareable ticket,
 * which changes every week while the image stays the same (ADR 0011). Every other part stays, the
 * width included, so a resized image and its original never share a key.
 */
export const artworkCacheKey = (url: string): string => {
  const query = url.indexOf("?");

  if (query === -1) return url;

  const base = url.slice(0, query);

  const kept = url
    .slice(query + 1)
    .split("&")
    .filter((pair) => pair.split("=")[0] !== TICKET_PARAM);

  return kept.length === 0 ? base : `${base}?${kept.join("&")}`;
};

/**
 * The width an image request's query asks for: none for the original, or the width. Fails with
 * the raw value when it is not one of `ARTWORK_WIDTHS`, which the media service refuses.
 */
export const requestedArtworkWidth = (
  query: URLSearchParams,
): Result.Result<Option.Option<ArtworkWidth>, string> => {
  const raw = query.get(ARTWORK_WIDTH_PARAM);

  if (raw === null) return Result.succeedNone;

  return Option.match(decodeWidth(raw), {
    onNone: () => Result.fail(raw),
    onSome: (width) => Result.succeedSome(width),
  });
};

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
export const artworkUrl = (mediaBaseUrl: string, key: string, width?: ArtworkWidth): string =>
  sizedArtworkUrl(`${mediaBaseUrl.replace(/\/+$/u, "")}/artwork/${encodeURIComponent(key)}`, width);
