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

import {
  DownloadEvent,
  EMPTY_STORE,
  downloadIdOf,
  downloadFor,
  downloadsOf,
  factsOf,
  headingOf,
  keptLine,
  lineOf,
  mayTransfer,
  nextToRun,
  parseStore,
  reduce,
  serializeStore,
  spaceShortfall,
  statusOf,
  summaryOf,
} from "./model";
import type { Delivery, DownloadStore, NewDownload } from "./model";

const alex = ProfileId.make("profile-alex");

const kids = ProfileId.make("profile-kids");

const dune = TitleId.make("title-dune");

const severance = TitleId.make("title-severance");

const episode = EpisodeId.make("episode-3");

const movie: NewDownload = {
  profileId: alex,
  titleId: dune,
  episodeId: null,
  fileId: null,
  quality: "standard",
  titleName: "Dune: Part Two",
  episodeName: null,
  seasonNumber: null,
  episodeNumber: null,
  runtimeMs: 9_960_000,
  artwork: "backdrop-dune",
};

const show: NewDownload = {
  ...movie,
  titleId: severance,
  episodeId: episode,
  titleName: "Severance",
  episodeName: "Who Is Alive?",
  seasonNumber: 2,
  episodeNumber: 3,
  runtimeMs: 3_180_000,
};

const delivery: Delivery = {
  fileId: MediaFileId.make("file-1"),
  sizeBytes: 842_000_000,
  container: "mp4",
  durationMs: 3_180_000,
  videoCodec: "h264",
  width: 1280,
  height: 720,
  audio: { streamIndex: 1, codec: "aac", channels: 2 },
  subtitles: [],
};

const playback = {
  episode: null,
  file: Schema.decodeSync(MediaFile)({
    id: "file-1",
    titleId: "title-severance",
    episodeId: "episode-3",
    versionName: null,
    sizeBytes: 2_000_000_000,
    probe: {
      container: "mkv",
      durationMs: 3_180_000,
      bitRate: null,
      video: [],
      audio: [],
      subtitles: [],
    },
    externalSubtitles: [],
    hdr: false,
    missing: false,
    trickplay: null,
  }),
  resumePositionMs: Milliseconds.make(0),
};

const sessionId = PlaybackSessionId.make("session-1");

const run = (...events: ReadonlyArray<DownloadEvent>): DownloadStore =>
  events.reduce(reduce, EMPTY_STORE);

const movieId = downloadIdOf(alex, dune, null);

const showId = downloadIdOf(alex, severance, episode);

describe("the download store", () => {
  it("queues each item once per profile, oldest first", () => {
    const store = run(
      DownloadEvent.Added({ download: show, at: 2 }),
      DownloadEvent.Added({ download: movie, at: 1 }),
      DownloadEvent.Added({ download: movie, at: 3 }),
      DownloadEvent.Added({ download: { ...movie, profileId: kids }, at: 4 }),
    );

    expect(downloadsOf(store, alex).map((download) => download.id)).toStrictEqual([
      movieId,
      showId,
    ]);
    expect(downloadsOf(store, kids)).toHaveLength(1);
    expect(downloadFor(store, movieId, alex)?.profileId).toBe(alex);
    expect(downloadFor(store, showId, kids)).toBeUndefined();
    expect(downloadFor(store, null, alex)).toBeUndefined();
    expect(nextToRun(store)?.id).toBe(movieId);
    expect(nextToRun(store, new Set([movieId]))?.id).toBe(showId);
  });

  it("walks a download through preparing, downloading, and ready", () => {
    const preparing = run(
      DownloadEvent.Added({ download: show, at: 1 }),
      DownloadEvent.Preparing({ id: showId, progress: 0.34, estimatedBytes: 1_000_000_000 }),
    );

    const [prepared] = downloadsOf(preparing, alex);

    expect(prepared === undefined ? null : lineOf(prepared)).toBe("Severance · Preparing · 34%");

    const downloading = [
      DownloadEvent.Delivering({ id: showId, delivery, playback, sessionId }),
      DownloadEvent.Received({ id: showId, bytes: 538_880_000 }),
    ].reduce(reduce, preparing);

    const [partial] = downloadsOf(downloading, alex);

    expect(partial === undefined ? null : statusOf(partial)).toBe("Downloading · 64%");
    expect(nextToRun(downloading)).toBeNull();

    const ready = reduce(downloading, DownloadEvent.Finished({ id: showId }));
    const [kept] = downloadsOf(ready, alex);

    expect(
      kept === undefined ? null : [headingOf(kept), lineOf(kept), factsOf(kept), keptLine(kept)],
    ).toStrictEqual([
      "3. Who Is Alive?",
      "Severance · Ready to Play",
      "Season 2, Episode 3 · 53m",
      "Downloaded · 720p · 842 MB",
    ]);
    expect(summaryOf(downloadsOf(ready, alex))).toStrictEqual({
      items: "1 Item",
      size: "842 MB",
      bytes: 842_000_000,
    });
  });

  it("waits for Wi-Fi, is interrupted, and queues again on retry", () => {
    const waiting = run(
      DownloadEvent.Added({ download: movie, at: 1 }),
      DownloadEvent.Waiting({ id: movieId, wifi: true, resume: "saved" }),
    );

    expect(downloadsOf(waiting, alex).map(statusOf)).toStrictEqual(["Waiting for Wi-Fi"]);
    expect(nextToRun(waiting)?.resume).toBe("saved");

    const interrupted = reduce(
      waiting,
      DownloadEvent.Interrupted({
        id: movieId,
        error: "Your server is unavailable.",
        resume: null,
      }),
    );

    expect(downloadsOf(interrupted, alex).map(statusOf)).toStrictEqual(["Download interrupted"]);
    expect(nextToRun(interrupted)).toBeNull();
    expect(
      downloadsOf(reduce(interrupted, DownloadEvent.Retried({ id: movieId })), alex).map(statusOf),
    ).toStrictEqual(["Queued"]);
  });

  it("starts every delivery at the first byte, and keeps its session to end later", () => {
    const later = PlaybackSessionId.make("session-2");

    const store = run(
      DownloadEvent.Added({ download: movie, at: 1 }),
      DownloadEvent.SessionStarted({ id: movieId, sessionId: later }),
    );

    expect(store.downloads[0]?.sessionId).toBe(later);

    const received = run(
      DownloadEvent.Added({ download: movie, at: 1 }),
      DownloadEvent.Delivering({ id: movieId, delivery, playback, sessionId }),
      DownloadEvent.Received({ id: movieId, bytes: 100 }),
    );

    expect(
      reduce(received, DownloadEvent.Delivering({ id: movieId, delivery, playback, sessionId }))
        .downloads[0]?.receivedBytes,
    ).toBe(0);

    const full = reduce(received, DownloadEvent.NoSpace({ id: movieId, totalBytes: 500 }));

    expect([full.downloads[0]?.receivedBytes, full.downloads[0]?.totalBytes]).toStrictEqual([
      0, 500,
    ]);
  });

  it("removes one download, or all of one profile's", () => {
    const store = run(
      DownloadEvent.Added({ download: movie, at: 1 }),
      DownloadEvent.Added({ download: show, at: 2 }),
      DownloadEvent.Added({ download: { ...movie, profileId: kids }, at: 3 }),
    );

    expect(downloadsOf(reduce(store, DownloadEvent.Removed({ id: movieId })), alex)).toHaveLength(
      1,
    );

    const cleared = reduce(store, DownloadEvent.RemovedAll({ profileId: alex }));

    expect(downloadsOf(cleared, alex)).toHaveLength(0);
    expect(downloadsOf(cleared, kids)).toHaveLength(1);
  });

  it("queues the latest offline position of each item until the server took it", () => {
    const played = run(
      DownloadEvent.Added({ download: movie, at: 1 }),
      DownloadEvent.Delivering({ id: movieId, delivery, playback, sessionId }),
      DownloadEvent.Finished({ id: movieId }),
      DownloadEvent.Played({ id: movieId, positionMs: 1_000, durationMs: 3_180_000, at: 10 }),
      DownloadEvent.Played({ id: movieId, positionMs: 2_000, durationMs: 3_180_000, at: 20 }),
    );

    expect(played.pendingProgress).toStrictEqual([
      {
        profileId: alex,
        titleId: dune,
        episodeId: null,
        fileId: delivery.fileId,
        positionMs: 2_000,
        durationMs: 3_180_000,
        playedAt: 20,
      },
    ]);
    expect(played.downloads[0]?.positionMs).toBe(2_000);

    const [sent] = played.pendingProgress;

    const later = reduce(
      played,
      DownloadEvent.Played({ id: movieId, positionMs: 3_000, durationMs: 3_180_000, at: 30 }),
    );

    expect(
      reduce(later, DownloadEvent.ProgressSent({ sent: sent === undefined ? [] : [sent] }))
        .pendingProgress,
    ).toHaveLength(1);
    expect(
      reduce(played, DownloadEvent.ProgressSent({ sent: played.pendingProgress })).pendingProgress,
    ).toHaveLength(0);
  });

  it("reads back what it wrote, and an unreadable store as empty", () => {
    const store = run(DownloadEvent.Added({ download: show, at: 1 }));

    expect(parseStore(serializeStore(store))).toStrictEqual(store);
    expect(parseStore("{")).toStrictEqual(EMPTY_STORE);

    const [kept] = store.downloads;
    const { sessionId: _absent, ...older } = kept ?? fail();
    const mixed = JSON.stringify({ downloads: [older, { id: 1 }], pendingProgress: [] });

    expect(parseStore(mixed).downloads).toStrictEqual([{ ...older, sessionId: null }]);
    expect(parseStore(null)).toStrictEqual(EMPTY_STORE);
  });
});

describe("transfers and space", () => {
  it("transfers on Wi-Fi, and on mobile data only without Wi-Fi Only", () => {
    expect(mayTransfer({ connected: true, wifi: true }, true)).toBe(true);
    expect(mayTransfer({ connected: true, wifi: false }, true)).toBe(false);
    expect(mayTransfer({ connected: true, wifi: false }, false)).toBe(true);
    expect(mayTransfer({ connected: false, wifi: false }, false)).toBe(false);
  });

  it("asks to free what a download needs beyond the free space and the reserve", () => {
    expect(spaceShortfall(1_000_000_000, 10_000_000_000)).toBe(0);
    expect(spaceShortfall(1_000_000_000, 300_000_000)).toBe(1_200_000_000);
  });
});

function fail(): never {
  throw new Error("The store has no download");
}
