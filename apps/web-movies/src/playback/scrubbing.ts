import type { Chapter } from "@media/contracts/models/catalog";
import type { StartedPlayback } from "@media/contracts/models/playback";
import { TICKET_PARAM } from "@media/contracts/ticket";
import { trickplaySheetUrl, trickplayTile } from "@media/contracts/trickplay";
import type { ChapterOption } from "@media/ui/components/chapter-popover";
import type { ScrubPreview } from "@media/ui/components/player-controls";
import type { SpriteTile } from "@media/ui/components/sprite-thumbnail";
import { useCallback, useMemo, useRef } from "react";

type TileAt = (seconds: number) => SpriteTile | null;

const NO_TILES: TileAt = () => null;

interface Thumbnails {
  readonly tileAt: TileAt;
  readonly sheets: ReadonlyArray<string>;
}

/**
 * `url` carrying `ticket` in the parameter the media server reads tickets from, in place of the
 * old playback token's parameter the trickplay helpers write.
 */
const withTicket = (url: string, ticket: string): string => {
  const parsed = new URL(url);

  parsed.searchParams.delete("token");
  parsed.searchParams.set(TICKET_PARAM, ticket);

  return parsed.toString();
};

/**
 * Thumbnails of `started`'s file, and the URLs of all its sheets, which carry its ticket (the
 * start's `token`).
 */
export const thumbnailsOf = (
  started: Pick<StartedPlayback, "file" | "token" | "mediaBaseUrl"> | null,
): Thumbnails => {
  const manifest = started?.file.trickplay ?? null;

  if (started === null || manifest === null) return { tileAt: NO_TILES, sheets: [] };

  const sheetUrl = (sheet: number): string =>
    withTicket(
      trickplaySheetUrl(started.mediaBaseUrl, started.file.id, manifest, sheet, started.token),
      started.token,
    );

  return {
    tileAt: (seconds) => {
      const tile = trickplayTile(manifest, seconds * 1000);

      return {
        url: sheetUrl(tile.sheet),
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
        sheetWidth: manifest.columns * manifest.tileWidth,
        sheetHeight: manifest.rows * manifest.tileHeight,
      };
    },
    sheets: Array.from({ length: manifest.sheetCount }, (_, sheet) => sheetUrl(sheet)),
  };
};

/** The file's chapters as the menu lists them; unnamed ones are numbered. */
export const chapterOptions = (
  chapters: ReadonlyArray<Chapter>,
  tileAt: TileAt,
): ReadonlyArray<ChapterOption> =>
  chapters.map((chapter, index) => ({
    id: String(index),
    title: chapter.title ?? `Chapter ${String(index + 1)}`,
    startSeconds: chapter.startMs / 1000,
    thumbnail: tileAt(chapter.startMs / 1000),
  }));

/** The chapter playing at `seconds`: the last one that started at or before it. */
export const chapterAt = (
  chapters: ReadonlyArray<ChapterOption>,
  seconds: number,
): ChapterOption | null =>
  chapters.findLast((chapter) => chapter.startSeconds <= seconds + 0.001) ?? null;

/** The scrubber's and the chapters menu's view of the file playing. */
export interface Scrubbing {
  readonly chapters: ReadonlyArray<ChapterOption>;
  /** Chapter starts in seconds, for the scrubber's marks. */
  readonly chapterStarts: ReadonlyArray<number>;
  readonly describe: (seconds: number) => ScrubPreview;
  /** Starts loading every sheet, once per file; call it when the viewer reaches for the scrubber. */
  readonly preload: () => void;
}

/** Scrubbing for `started`'s file, or nothing to show before playback starts. */
export const useScrubbing = (started: StartedPlayback | null): Scrubbing => {
  const { tileAt, sheets } = useMemo(() => thumbnailsOf(started), [started]);
  const loaded = useRef<ReadonlySet<string>>(new Set());

  const chapters = useMemo(
    () => chapterOptions(started?.file.probe.chapters ?? [], tileAt),
    [started, tileAt],
  );

  const preload = useCallback(() => {
    const missing = sheets.filter((url) => !loaded.current.has(url));

    if (missing.length === 0) return;
    loaded.current = new Set([...loaded.current, ...missing]);

    for (const url of missing) {
      const image = new Image();

      image.src = url;
    }
  }, [sheets]);

  const describe = useCallback(
    (seconds: number): ScrubPreview => ({
      thumbnail: tileAt(seconds),
      chapter: chapterAt(chapters, seconds)?.title ?? null,
    }),
    [tileAt, chapters],
  );

  const chapterStarts = useMemo(() => chapters.map((chapter) => chapter.startSeconds), [chapters]);

  return { chapters, chapterStarts, describe, preload };
};
