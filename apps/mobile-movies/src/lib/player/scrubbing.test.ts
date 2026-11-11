import { MediaFileId } from "@media/contracts/ids";
import { Milliseconds } from "@media/contracts/units";
import { describe, expect, it } from "vitest";

import { chapterRows, scrubTileAt } from "./scrubbing";

const chapter = (startMs: number, title: string | null) => ({
  startMs: Milliseconds.make(startMs),
  endMs: Milliseconds.make(startMs + 1000),
  title,
});

describe("scrubTileAt", () => {
  const manifest = {
    version: "abc-def",
    intervalMs: 10_000,
    tileWidth: 320,
    tileHeight: 180,
    columns: 10,
    rows: 10,
    thumbnailCount: 150,
    sheetCount: 2,
  };

  it("cuts the thumbnail at a time from its sheet, with the playback token", () => {
    const tile = scrubTileAt(
      {
        file: { id: MediaFileId.make("file 1"), trickplay: manifest },
        token: "t&k",
        mediaBaseUrl: "http://m:1/",
      },
      1015,
    );

    expect(tile).toStrictEqual({
      url: "http://m:1/media/trickplay/file%201/abc-def/1.jpg?token=t%26k",
      sheetWidth: 3200,
      sheetHeight: 1800,
      x: 320,
      y: 0,
      width: 320,
      height: 180,
    });
  });

  it("has none before thumbnails are generated", () => {
    expect(
      scrubTileAt(
        {
          file: { id: MediaFileId.make("f"), trickplay: null },
          token: "t",
          mediaBaseUrl: "http://m",
        },
        5,
      ),
    ).toBeNull();
  });
});

describe("chapters", () => {
  const rows = chapterRows([
    chapter(0, "Arrakis"),
    chapter(1_458_000, null),
    chapter(3_764_000, " "),
  ]);

  it("numbers chapters and names the unnamed", () => {
    expect(rows).toStrictEqual([
      { title: "1. Arrakis", startSeconds: 0 },
      { title: "Chapter 2", startSeconds: 1458 },
      { title: "Chapter 3", startSeconds: 3764 },
    ]);
  });
});
