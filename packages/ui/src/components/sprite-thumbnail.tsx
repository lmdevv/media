import { cn } from "@media/ui/lib/utils";

/** One tile of a sprite sheet: the sheet's URL and size and the tile's rectangle, in pixels. */
export interface SpriteTile {
  readonly url: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly sheetWidth: number;
  readonly sheetHeight: number;
}

const offset = (start: number, size: number, sheet: number): string =>
  sheet <= size ? "0%" : `${String((start / (sheet - size)) * 100)}%`;

/**
 * One frame cut from a sprite sheet, such as a scrub thumbnail, at whatever width `className`
 * gives it; the height follows the tile's aspect ratio. The sheet is a background image, so a
 * failed load leaves the raised placeholder.
 */
export function SpriteThumbnail({
  tile,
  className,
}: {
  readonly tile: SpriteTile;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      data-slot="sprite-thumbnail"
      className={cn("block overflow-hidden rounded-bar bg-surface-raised bg-no-repeat", className)}
      style={{
        aspectRatio: `${String(tile.width)} / ${String(tile.height)}`,
        backgroundImage: `url("${tile.url}")`,
        backgroundSize: `${String((tile.sheetWidth / tile.width) * 100)}% ${String((tile.sheetHeight / tile.height) * 100)}%`,
        backgroundPosition: `${offset(tile.x, tile.width, tile.sheetWidth)} ${offset(tile.y, tile.height, tile.sheetHeight)}`,
      }}
    />
  );
}
