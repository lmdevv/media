import { Brand, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { EpisodeId, TitleId } from "../catalog";
import {
  DownloadEvent,
  EMPTY_STORE,
  downloadFor,
  downloadsOf,
  factsOf,
  headingOf,
  keptLine,
  keptPlaybackOf,
  lineOf,
  mayTransfer,
  nameOf,
  nextToRun,
  parseStore,
  pictureOf,
  planSync,
  reduce,
  serializeStore,
  spaceShortfall,
  statusOf,
  summaryOf,
} from "./model";
import type {
  CoreStart,
  Delivery,
  DownloadStore,
  FileId,
  KeptPlayback,
  NewDownload,
} from "./model";

const asFileId = Brand.nominal<FileId>();

const asTitleId = Brand.nominal<TitleId>();

const asEpisodeId = Brand.nominal<EpisodeId>();

const duneFile = asFileId("file-dune");

const episodeFile = asFileId("file-severance-203");

const movie: NewDownload = {
  id: duneFile,
  titleId: asTitleId("title-dune"),
  episodeId: null,
  titleName: "Dune: Part Two",
  runtimeMs: 9_960_000,
  artwork: "/artwork/backdrop-dune?ticket=t",
};

const show: NewDownload = {
  id: episodeFile,
  titleId: asTitleId("title-severance"),
  episodeId: asEpisodeId("episode-3"),
  titleName: "Severance",
  runtimeMs: 3_000_000,
  artwork: "/artwork/backdrop-severance?ticket=t",
};

/** What `movies.play.start` answers for the episode's file. */
const start: Pick<CoreStart, "episode" | "file" | "resumePositionMs"> = {
  episode: {
    id: asEpisodeId("episode-3"),
    titleId: asTitleId("title-severance"),
    seasonId: Brand.nominal<NonNullable<CoreStart["episode"]>["seasonId"]>()("season-2"),
    seasonNumber: 2,
    episodeNumber: 3,
    name: "Who Is Alive?",
    overview: null,
    airDate: null,
    runtimeMs: 3_180_000,
    still: "/artwork/still-203?ticket=t",
    rating: null,
    externalIds: { tmdb: null, imdb: null, tvdb: null },
    available: true,
    progress: null,
  },
  file: {
    id: episodeFile,
    titleId: asTitleId("title-severance"),
    episodeId: asEpisodeId("episode-3"),
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
    trickplay: null,
  },
  resumePositionMs: 0,
};

const playback: KeptPlayback = Option.getOrThrow(keptPlaybackOf(start));

const delivery: Delivery = {
  sizeBytes: 842_000_000,
  container: "mp4",
  durationMs: 3_180_000,
  videoCodec: "h264",
  width: 1280,
  height: 720,
  audio: { streamIndex: 1, codec: "aac", channels: 2 },
  subtitles: [],
};

const run = (...events: ReadonlyArray<DownloadEvent>): DownloadStore =>
  events.reduce(reduce, EMPTY_STORE);

const delivering = (id: FileId, revision = "r1") =>
  DownloadEvent.Delivering({ id, delivery, revision, ticketExpiresAt: 900_000 });

const kept = (id: FileId, revision = "r1"): ReadonlyArray<DownloadEvent> => [
  DownloadEvent.Confirmed({ id }),
  delivering(id, revision),
  DownloadEvent.Finished({ id }),
];

describe("the download store", () => {
  it("queues each file once, oldest first", () => {
    const store = run(
      DownloadEvent.Added({ download: show, at: 2 }),
      DownloadEvent.Added({ download: movie, at: 1 }),
      DownloadEvent.Added({ download: movie, at: 3 }),
    );

    expect(downloadsOf(store).map((download) => download.id)).toStrictEqual([
      duneFile,
      episodeFile,
    ]);
    expect(downloadFor(store, duneFile)?.added).toBe(false);
    expect(downloadFor(store, null)).toBeUndefined();
    expect(nextToRun(store)?.id).toBe(duneFile);
    expect(nextToRun(store, new Set([duneFile]))?.id).toBe(episodeFile);
  });

  it("names an episode once its playback is described", () => {
    const added = run(DownloadEvent.Added({ download: show, at: 1 }));
    const [before] = downloadsOf(added);

    expect(before === undefined ? null : [headingOf(before), lineOf(before)]).toStrictEqual([
      "Severance",
      "Queued",
    ]);

    const described = reduce(added, DownloadEvent.Described({ id: episodeFile, playback }));
    const [after] = downloadsOf(described);

    expect(
      after === undefined ? null : [nameOf(after), pictureOf(after), factsOf(after)],
    ).toStrictEqual(["Who Is Alive?", "/artwork/still-203?ticket=t", "Season 2, Episode 3 · 53m"]);
    expect(
      pictureOf(downloadsOf(run(DownloadEvent.Added({ download: movie, at: 1 })))[0] ?? fail()),
    ).toBe(movie.artwork);
  });

  it("walks a download through preparing, downloading, and ready", () => {
    const preparing = run(
      DownloadEvent.Added({ download: show, at: 1 }),
      DownloadEvent.Described({ id: episodeFile, playback }),
      DownloadEvent.Preparing({ id: episodeFile, progress: 0.34, estimatedBytes: 1_000_000_000 }),
    );

    const [prepared] = downloadsOf(preparing);

    expect(prepared === undefined ? null : lineOf(prepared)).toBe("Severance · Preparing · 34%");

    const downloading = [
      delivering(episodeFile),
      DownloadEvent.Received({ id: episodeFile, bytes: 538_880_000 }),
    ].reduce(reduce, preparing);

    const [partial] = downloadsOf(downloading);

    expect(partial === undefined ? null : statusOf(partial)).toBe("Downloading · 64%");
    expect(nextToRun(downloading)).toBeNull();

    const ready = reduce(downloading, DownloadEvent.Finished({ id: episodeFile }));
    const [done] = downloadsOf(ready);

    expect(
      done === undefined ? null : [headingOf(done), lineOf(done), keptLine(done), done.revision],
    ).toStrictEqual([
      "3. Who Is Alive?",
      "Severance · Ready to Play",
      "Downloaded · 720p · 842 MB",
      "r1",
    ]);
    expect(summaryOf(downloadsOf(ready))).toStrictEqual({
      items: "1 Item",
      size: "842 MB",
      bytes: 842_000_000,
    });
  });

  it("waits for Wi-Fi, is interrupted, and queues again on retry", () => {
    const waiting = run(
      DownloadEvent.Added({ download: movie, at: 1 }),
      DownloadEvent.Waiting({ id: duneFile, wifi: true, resume: "saved" }),
    );

    expect(downloadsOf(waiting).map(statusOf)).toStrictEqual(["Waiting for Wi-Fi"]);
    expect(nextToRun(waiting)?.resume).toBe("saved");

    const interrupted = reduce(
      waiting,
      DownloadEvent.Interrupted({
        id: duneFile,
        error: "Your server is unavailable.",
        resume: null,
      }),
    );

    expect(downloadsOf(interrupted).map(statusOf)).toStrictEqual(["Download interrupted"]);
    expect(nextToRun(interrupted)).toBeNull();
    expect(
      downloadsOf(reduce(interrupted, DownloadEvent.Retried({ id: duneFile }))).map(statusOf),
    ).toStrictEqual(["Queued"]);
  });

  it("starts every delivery at the first byte", () => {
    const received = run(
      DownloadEvent.Added({ download: movie, at: 1 }),
      delivering(duneFile),
      DownloadEvent.Received({ id: duneFile, bytes: 100 }),
    );

    expect(reduce(received, delivering(duneFile)).downloads[0]?.receivedBytes).toBe(0);

    const full = reduce(received, DownloadEvent.NoSpace({ id: duneFile, totalBytes: 500 }));

    expect([full.downloads[0]?.receivedBytes, full.downloads[0]?.totalBytes]).toStrictEqual([
      0, 500,
    ]);
  });

  it("expires a kept copy until access comes back, then downloads it again", () => {
    const expired = reduce(
      run(DownloadEvent.Added({ download: movie, at: 1 }), ...kept(duneFile)),
      DownloadEvent.Expired({ id: duneFile }),
    );

    const [shown] = downloadsOf(expired);

    expect(shown === undefined ? null : [statusOf(shown), shown.delivery]).toStrictEqual([
      "Expired",
      null,
    ]);
    expect(nextToRun(expired)).toBeNull();
    expect(
      reduce(expired, DownloadEvent.Waiting({ id: duneFile, wifi: false, resume: null }))
        .downloads[0]?.phase,
    ).toBe("expired");

    const refreshed = reduce(expired, DownloadEvent.Refreshed({ id: duneFile }));

    expect(nextToRun(refreshed)?.id).toBe(duneFile);
    expect(refreshed.downloads[0]?.added).toBe(true);
  });

  it("queues the latest offline position of each file until the server took it", () => {
    const played = run(
      DownloadEvent.Added({ download: movie, at: 1 }),
      ...kept(duneFile),
      DownloadEvent.Played({ id: duneFile, positionMs: 1_000, durationMs: 3_180_000, at: 10 }),
      DownloadEvent.Played({ id: duneFile, positionMs: 2_000, durationMs: 3_180_000, at: 20 }),
    );

    expect(played.pendingProgress).toStrictEqual([
      { fileId: duneFile, positionMs: 2_000, durationMs: 3_180_000, playedAt: 20 },
    ]);
    expect(played.downloads[0]?.positionMs).toBe(2_000);

    const [sent] = played.pendingProgress;

    const later = reduce(
      played,
      DownloadEvent.Played({ id: duneFile, positionMs: 3_000, durationMs: 3_180_000, at: 30 }),
    );

    expect(
      reduce(later, DownloadEvent.ProgressSent({ sent: sent === undefined ? [] : [sent] }))
        .pendingProgress,
    ).toHaveLength(1);
    expect(
      reduce(played, DownloadEvent.ProgressSent({ sent: played.pendingProgress })).pendingProgress,
    ).toHaveLength(0);
  });

  it("reads back what it wrote, and skips what it cannot read", () => {
    const store = run(
      DownloadEvent.Added({ download: show, at: 1 }),
      DownloadEvent.Described({ id: episodeFile, playback }),
    );

    expect(parseStore(serializeStore(store))).toStrictEqual(store);
    expect(parseStore("{")).toStrictEqual(EMPTY_STORE);
    expect(parseStore(null)).toStrictEqual(EMPTY_STORE);

    const older = { id: "profile-title-movie", profileId: "profile", phase: "ready" };

    const mixed = JSON.stringify({
      downloads: [older, ...store.downloads],
      pendingProgress: [{ profileId: "profile" }],
    });

    expect(parseStore(mixed)).toStrictEqual(store);
  });
});

describe("following the core's list", () => {
  const store = run(
    DownloadEvent.Added({ download: movie, at: 1 }),
    ...kept(duneFile),
    DownloadEvent.Added({ download: show, at: 2 }),
    ...kept(episodeFile),
  );

  const both = new Set<string>([duneFile, episodeFile]);

  it("keeps what is available at the revision it holds", () => {
    expect(
      planSync(
        store,
        [
          { id: duneFile, state: "available", revision: "r1" },
          { id: episodeFile, state: "available", revision: "r1" },
        ],
        both,
      ),
    ).toStrictEqual({ expire: [], refresh: [], drop: [], purge: [], forget: [] });
  });

  it("expires, drops, and downloads a new revision again", () => {
    expect(
      planSync(
        store,
        [
          { id: duneFile, state: "expired" },
          { id: episodeFile, state: "available", revision: "r2" },
        ],
        both,
      ),
    ).toStrictEqual({
      expire: [duneFile],
      refresh: [episodeFile],
      drop: [],
      purge: [],
      forget: [],
    });

    expect(
      planSync(
        store,
        [
          { id: duneFile, state: "gone" },
          { id: episodeFile, state: "available", revision: "r1" },
        ],
        both,
      ).drop,
    ).toStrictEqual([duneFile]);
  });

  it("brings an expired download back once access returns", () => {
    const expired = reduce(store, DownloadEvent.Expired({ id: duneFile }));

    expect(planSync(expired, [{ id: duneFile, state: "expired" }], both).expire).toStrictEqual([]);
    expect(
      planSync(expired, [{ id: duneFile, state: "available", revision: "r1" }], both).refresh,
    ).toStrictEqual([duneFile]);
  });

  it("purges only what the core had taken and no longer lists, and forgets what it holds nothing of", () => {
    const stranger = asFileId("file-unknown");

    const withNew = reduce(
      reduce(
        store,
        DownloadEvent.Added({ download: { ...movie, id: asFileId("file-new") }, at: 3 }),
      ),
      DownloadEvent.Confirmed({ id: "file-new" }),
    );

    expect(
      planSync(withNew, [{ id: stranger, state: "available", revision: "r1" }], both),
    ).toStrictEqual({
      expire: [],
      refresh: [],
      drop: [],
      purge: [duneFile, episodeFile],
      forget: [stranger],
    });
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
