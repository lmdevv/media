import {
  EpisodeId,
  MediaFileId,
  PlaybackSessionId,
  ProfileId,
  TitleId,
} from "@media/contracts/ids";
import { MediaFile } from "@media/contracts/models/catalog";
import { Milliseconds } from "@media/contracts/units";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DownloadEvent, EMPTY_STORE, reduce } from "./model";
import { downloadPlayback } from "./playback";

const file = Schema.decodeSync(MediaFile)({
  id: "file-1",
  titleId: "title-1",
  episodeId: "episode-1",
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
  missing: false,
  trickplay: null,
});

const kept = [
  DownloadEvent.Added({
    download: {
      profileId: ProfileId.make("profile-1"),
      titleId: TitleId.make("title-1"),
      episodeId: EpisodeId.make("episode-1"),
      fileId: null,
      quality: "standard",
      titleName: "Severance",
      episodeName: "Who Is Alive?",
      seasonNumber: 2,
      episodeNumber: 3,
      runtimeMs: 600_000,
      artwork: null,
    },
    at: 1,
  }),
  DownloadEvent.Delivering({
    id: "profile-1-title-1-episode-1",
    delivery: {
      fileId: MediaFileId.make("file-1"),
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
    playback: { episode: null, file, resumePositionMs: Milliseconds.make(120_000) },
    sessionId: PlaybackSessionId.make("session-1"),
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
    const ready = reduce(kept, DownloadEvent.Finished({ id: "profile-1-title-1-episode-1" }));
    const playback = downloadPlayback(ready.downloads[0] ?? fail(), files, 1_000);

    expect(playback?.stream).toMatchObject({
      mode: "direct",
      url: files.video,
      startSeconds: 120,
      durationSeconds: 600,
      subtitles: [{ id: "e3", kind: "text", url: "file:///downloads/subtitle-e3.vtt" }],
    });
    expect(playback?.started.file.id).toBe("file-1");

    const played = reduce(
      ready,
      DownloadEvent.Played({
        id: "profile-1-title-1-episode-1",
        positionMs: 300_000,
        durationMs: 600_000,
        at: 2,
      }),
    );

    expect(downloadPlayback(played.downloads[0] ?? fail(), files, 1_000)?.stream.startSeconds).toBe(
      300,
    );
  });
});

function fail(): never {
  throw new Error("The store has no download");
}
