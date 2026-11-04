import { MediaFile } from "@media/contracts/models/catalog";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { chapterAt, chapterOptions, thumbnailsOf } from "./scrubbing";

const file = Schema.decodeSync(MediaFile)({
  id: "file1",
  titleId: "title1",
  episodeId: null,
  versionName: null,
  sizeBytes: 1_000,
  probe: {
    container: "mp4",
    durationMs: 1_500_000,
    bitRate: null,
    video: [],
    audio: [],
    subtitles: [],
    chapters: [
      { startMs: 0, endMs: 600_000, title: "Opening" },
      { startMs: 600_000, endMs: 1_500_000, title: null },
    ],
  },
  externalSubtitles: [],
  hdr: false,
  missing: false,
  trickplay: {
    version: "abc-def",
    intervalMs: 10_000,
    tileWidth: 320,
    tileHeight: 180,
    columns: 10,
    rows: 10,
    thumbnailCount: 150,
    sheetCount: 2,
  },
});

const started = { file, token: "v1.a.b", mediaBaseUrl: "http://media.lan:4300" };

describe("thumbnailsOf", () => {
  it("places a time on its sheet with the session's token", () => {
    const { tileAt, sheets } = thumbnailsOf(started);

    expect(sheets).toEqual([
      "http://media.lan:4300/media/trickplay/file1/abc-def/0.jpg?token=v1.a.b",
      "http://media.lan:4300/media/trickplay/file1/abc-def/1.jpg?token=v1.a.b",
    ]);
    expect(tileAt(1_045)).toEqual({
      url: "http://media.lan:4300/media/trickplay/file1/abc-def/1.jpg?token=v1.a.b",
      x: 1_280,
      y: 0,
      width: 320,
      height: 180,
      sheetWidth: 3_200,
      sheetHeight: 1_800,
    });
  });

  it("has nothing for files without thumbnails or before playback starts", () => {
    expect(thumbnailsOf({ ...started, file: { ...file, trickplay: null } }).tileAt(10)).toBeNull();
    expect(thumbnailsOf(null).sheets).toEqual([]);
  });
});

describe("chapters", () => {
  const options = chapterOptions(file.probe.chapters ?? [], () => null);

  it("numbers unnamed chapters and finds the chapter playing", () => {
    expect(options.map((chapter) => [chapter.title, chapter.startSeconds])).toEqual([
      ["Opening", 0],
      ["Chapter 2", 600],
    ]);
    expect(chapterAt(options, 0)?.title).toBe("Opening");
    expect(chapterAt(options, 599.9)?.title).toBe("Opening");
    expect(chapterAt(options, 600)?.title).toBe("Chapter 2");
    expect(chapterAt([], 10)).toBeNull();
  });
});
