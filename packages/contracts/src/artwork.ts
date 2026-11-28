/**
 * Artwork URLs. Titles, seasons, and episodes carry artwork keys (`Artwork.poster`,
 * `Season.poster`, `Episode.still`, and so on): opaque, URL-safe strings the media service minted
 * while scanning. Clients load an image from `${mediaBaseUrl}/artwork/${key}`, resized to one of
 * `ARTWORK_WIDTHS` by its width with `?w=`, and a music cover from the path the music commands
 * answer (`/music/art/<hash>`), resized to one of `COVER_SIZES` by its shorter side with `?w=`,
 * since clients draw a cover as a square crop. Neither is enlarged. An image URL also carries a
 * shareable `ticket` for the key's `artworkTicketId` (`@media/contracts/ticket`), the same string
 * for a whole week, so images still cache (ADR 0011).
 */
import { Option, Result, Schema } from "effect";

import { TICKET_PARAM } from "./ticket";

/**
 * Widths the media service resizes movie artwork to. Other widths are refused, so the service
 * keeps at most this many resized copies of each image.
 */
export const ARTWORK_WIDTHS = [185, 342, 500, 780, 1280] as const;

/** A width the media service resizes artwork to. */
export const ArtworkWidth = Schema.Literals(ARTWORK_WIDTHS);

/** A width the media service resizes artwork to. */
export type ArtworkWidth = typeof ArtworkWidth.Type;

/**
 * The sizes, in pixels, the media service resizes a music cover's shorter side to: the sizes the
 * music apps draw covers at, so a cover in one of those cells is drawn pixel for pixel, never
 * scaled again on the device. Other sizes are refused, so the service keeps at most 11 copies of a
 * cover.
 *
 * - 96: a 48-point row at 2x, a 32-point thumbnail at 3x.
 * - 120: the 40-point mini player and queue rows at 3x.
 * - 144: a 48-point row at 3x.
 * - 336, 504: a 168-point card at 2x and 3x.
 * - 384: a 192-point album header at 2x, a 128-point playlist header at 3x.
 * - 480: a 160-point card at 3x, a 240-point header at 2x.
 * - 576: a 192-point album header at 3x.
 * - 720: a 240-point header at 3x.
 * - 960, 1280: steps for larger cells, past which the original is loaded.
 */
export const COVER_SIZES = [96, 120, 144, 336, 384, 480, 504, 576, 720, 960, 1280] as const;

/** A size the media service resizes a music cover's shorter side to. */
export const CoverSize = Schema.Literals(COVER_SIZES);

/** A size the media service resizes a music cover's shorter side to. */
export type CoverSize = typeof CoverSize.Type;

/**
 * How much larger than a cell a cover's copy must be for the device's own downscale not to soften
 * it, when no copy has the cell's exact size. Measured on the iOS simulator with copies 2% to 200%
 * larger than a 144-pixel row: up to 25% larger lost 3% to 10% of the row's sharpness to iOS's
 * second scaling, and from 75% larger the row was as sharp as one drawing the full original.
 */
const ENOUGH_LARGER = 1.75;

/**
 * The copy to ask for of a music cover drawn `pixels` big: the one of exactly that size, drawn
 * pixel for pixel, or else the smallest at least `ENOUGH_LARGER` times it, or undefined when only
 * the original is. The server bounds a cover's shorter side by the size, so the copy covers a
 * square cell of that size whatever the cover's shape.
 *
 * @param pixels - The drawn size in device pixels: the longer side of the cover's cell times the
 *   screen's pixel density, since a cover fills its cell.
 */
export const coverSizeFor = (pixels: number): CoverSize | undefined => {
  const drawn = Math.round(pixels);

  return (
    COVER_SIZES.find((size) => size === drawn) ??
    COVER_SIZES.find((size) => size >= drawn * ENOUGH_LARGER)
  );
};

/** The query parameter an image URL asks for a resized image with. */
export const ARTWORK_WIDTH_PARAM = "w";

/** `url` asking for a copy resized to `size`, or `url` unchanged for the original. */
export const sizedArtworkUrl = (url: string, size: number | undefined): string =>
  size === undefined
    ? url
    : `${url}${url.includes("?") ? "&" : "?"}${ARTWORK_WIDTH_PARAM}=${String(size)}`;

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
 * A reader of the size an image request's query asks for: none for the original, or the size.
 * It fails with the raw value when `decode` refuses it, which the media service answers with 400.
 */
const requestedSize =
  <A>(decode: (raw: string) => Option.Option<A>) =>
  (query: URLSearchParams): Result.Result<Option.Option<A>, string> => {
    const raw = query.get(ARTWORK_WIDTH_PARAM);

    if (raw === null) return Result.succeedNone;

    return Option.match(decode(raw), {
      onNone: () => Result.fail(raw),
      onSome: (size) => Result.succeedSome(size),
    });
  };

/** The width an artwork request asks for: none for the original, or one of `ARTWORK_WIDTHS`. */
export const requestedArtworkWidth = requestedSize(
  Schema.decodeUnknownOption(Schema.FiniteFromString.pipe(Schema.decodeTo(ArtworkWidth))),
);

/** The size a music cover request asks for: none for the original, or one of `COVER_SIZES`. */
export const requestedCoverSize = requestedSize(
  Schema.decodeUnknownOption(Schema.FiniteFromString.pipe(Schema.decodeTo(CoverSize))),
);

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
