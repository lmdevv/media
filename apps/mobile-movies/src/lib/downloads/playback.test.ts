import { Brand, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { MediaFileId, TitleId } from "../catalog";
import { DownloadEvent, EMPTY_STORE, keptPlaybackOf, reduce } from "./model";
import { downloadPlayback } from "./playback";

const fileId = Brand.nominal<MediaFileId>()("file-1");

const playback = Option.getOrThrow(
  keptPlaybackOf({
    episode: null,
    file: {
      id: fileId,
      titleId: Brand.nominal<TitleId>()("title-1"),
      episodeId: null,
      versionName: null,
      sizeBytes: 1,
      probe: {
        container: "mkv",
        durationMs: 600_000,
        bitRate: null,
        video: [],
        audio: [],
        subtitles: [],
      },
      externalSubtitles: [],
      hdr: false,
      trickplay: null,
    },
    resumePositionMs: 120_000,
  }),
);

const kept = [
  DownloadEvent.Added({
    download: {
      id: fileId,
      titleId: Brand.nominal<TitleId>()("title-1"),
      episodeId: null,
      titleName: "Arrival",
      runtimeMs: 600_000,
      artwork: null,
    },
    at: 1,
  }),
  DownloadEvent.Described({ id: fileId, playback }),
  DownloadEvent.Delivering({
    id: fileId,
    delivery: {
      sizeBytes: 1_000,
      container: "mp4",
      durationMs: 600_000,
      videoCodec: "h264",
      width: 1280,
      height: 720,
      audio: { streamIndex: 1, codec: "aac", channels: 2 },
      subtitles: [
        {
          id: "e3",
          language: "eng",
          title: null,
          forced: false,
          default: false,
          hearingImpaired: false,
        },
      ],
    },
    revision: "r1",
    ticketExpiresAt: 900_000,
  }),
].reduce(reduce, EMPTY_STORE);

const files = {
  video: "file:///downloads/video.mp4",
  subtitle: (trackId: string) => `file:///downloads/subtitle-${trackId}.vtt`,
};

describe("downloadPlayback", () => {
  it("plays nothing before the download is kept", () => {
    expect(downloadPlayback(kept.downloads[0] ?? fail(), files, 0)).toBeNull();
  });

  it("streams the local file directly, from the saved position, with local subtitles", () => {
    const ready = reduce(kept, DownloadEvent.Finished({ id: fileId }));
    const played = downloadPlayback(ready.downloads[0] ?? fail(), files, 1_000);

    expect(played?.stream).toMatchObject({
      mode: "direct",
      url: files.video,
      startSeconds: 120,
      durationSeconds: 600,
      subtitles: [{ id: "e3", kind: "text", url: "file:///downloads/subtitle-e3.vtt" }],
    });
    expect([played?.started.file.id, played?.started.titleId]).toStrictEqual(["file-1", "title-1"]);

    const later = reduce(
      ready,
      DownloadEvent.Played({ id: fileId, positionMs: 300_000, durationMs: 600_000, at: 2 }),
    );

    expect(downloadPlayback(later.downloads[0] ?? fail(), files, 1_000)?.stream.startSeconds).toBe(
      300,
    );
  });
});

function fail(): never {
  throw new Error("The store has no download");
}
