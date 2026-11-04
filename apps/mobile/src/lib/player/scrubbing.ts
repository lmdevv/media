import type { Chapter, MediaFile } from "@media/contracts/models/catalog";
import type { StartedPlayback } from "@media/contracts/models/playback";
import { trickplaySheetUrl, trickplayTile } from "@media/contracts/trickplay";

/** One thumbnail: its sheet's URL and size, and its rectangle on the sheet, in pixels. */
export interface ScrubTile {
  readonly url: string;
  readonly sheetWidth: number;
  readonly sheetHeight: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The scrub thumbnail at `seconds` of `started`'s file, or null when it has none. */
export const scrubTileAt = (
  started: Pick<StartedPlayback, "token" | "mediaBaseUrl"> & {
    readonly file: Pick<MediaFile, "id" | "trickplay">;
  },
  seconds: number,
): ScrubTile | null => {
  const manifest = started.file.trickplay;

  if (manifest === null) return null;

  const tile = trickplayTile(manifest, seconds * 1000);

  return {
    url: trickplaySheetUrl(
      started.mediaBaseUrl,
      started.file.id,
      manifest,
      tile.sheet,
      started.token,
    ),
    sheetWidth: manifest.columns * manifest.tileWidth,
    sheetHeight: manifest.rows * manifest.tileHeight,
    x: tile.x,
    y: tile.y,
    width: tile.width,
    height: tile.height,
  };
};

/** A chapter as Chapters lists it. */
export interface ChapterRow {
  /** `1. Arrakis`, or `Chapter 1` when the file names none. */
  readonly title: string;
  readonly startSeconds: number;
}

/** The file's chapters in order; unnamed ones are numbered. */
export const chapterRows = (chapters: ReadonlyArray<Chapter>): ReadonlyArray<ChapterRow> =>
  chapters.map((chapter, index) => {
    const number = String(index + 1);
    const name = chapter.title?.trim() ?? "";

    return {
      title: name === "" ? `Chapter ${number}` : `${number}. ${name}`,
      startSeconds: chapter.startMs / 1000,
    };
  });
