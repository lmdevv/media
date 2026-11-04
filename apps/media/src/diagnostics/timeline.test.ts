import type { LogLevel, LogRecord } from "@media/contracts/diagnostics";
import { PlaybackSessionId } from "@media/contracts/ids";
import { Option } from "effect";
import { assert, describe, it } from "vitest";

import { LogEvent } from "./log-events.ts";
import { driftFor, ownersOf, sessionsOf, timelineOf } from "./timeline.ts";

const BASE = Date.UTC(2026, 9, 21, 20);

const SESSION = PlaybackSessionId.make("session_a");

const record = (
  message: string,
  offsetMs: number,
  annotations: LogRecord["annotations"],
  level: LogLevel = "INFO",
): LogRecord => ({
  message,
  level,
  timestamp: new Date(BASE + offsetMs).toISOString(),
  annotations: { sessionId: SESSION, userId: "user_a", ...annotations },
});

const player = (
  message: string,
  loggedMs: number,
  occurredMs: number,
  annotations: LogRecord["annotations"],
  level: LogLevel = "INFO",
): LogRecord =>
  record(
    message,
    loggedMs,
    {
      source: "player",
      platform: "web",
      occurredAt: new Date(BASE + occurredMs).toISOString(),
      ...annotations,
    },
    level,
  );

const RECORDS: ReadonlyArray<LogRecord> = [
  record(LogEvent.streamStarted, 0, { streamId: "s1", mode: "remux" }),
  player(LogEvent.playerAttached, 5000, 100, { streamId: "s1", mode: "remux", engine: "hls.js" }),
  record(
    LogEvent.slowSegment,
    40_000,
    {
      streamId: "s1",
      segment: 12,
      elapsedMs: 32_900,
      encoderWaitMs: 31_000,
      diskReadMs: 3,
      networkWriteMs: 1897,
      completed: true,
    },
    "WARN",
  ),
  player(LogEvent.bufferingStarted, 45_000, 10_000, {
    streamId: "s1",
    positionSeconds: 70,
    bufferedAheadSeconds: 0,
  }),
  player(
    LogEvent.bufferingEnded,
    45_000,
    41_000,
    { streamId: "s1", positionSeconds: 70, bufferedAheadSeconds: 4, stalledMs: 31_000 },
    "WARN",
  ),
  player(
    LogEvent.fragmentLoaded,
    45_000,
    40_500,
    { streamId: "s1", segment: 12, elapsedMs: 30_400, firstByteMs: 30_000, bytes: 1_000_000 },
    "WARN",
  ),
  player(LogEvent.fragmentLoaded, 45_000, 41_500, {
    streamId: "s1",
    segment: 13,
    elapsedMs: 90,
    firstByteMs: 20,
    bytes: 1_000_000,
  }),
  player(
    LogEvent.recovery,
    50_000,
    49_000,
    { action: "renegotiate", reason: "StreamNotFound" },
    "WARN",
  ),
  record(
    LogEvent.requestFailed,
    48_000,
    { route: "hls", status: 404, error: "StreamNotFound", streamId: "s1" },
    "WARN",
  ),
  record(LogEvent.streamEnded, 47_000, { streamId: "s1", reason: "idle" }),
  record("Sent HTTP response", 47_500, {}),
];

describe("playback timeline", () => {
  const timeline = Option.getOrThrow(timelineOf(SESSION, RECORDS, false));

  it("orders events by when they happened, not when they were logged", () => {
    assert.deepStrictEqual(
      timeline.entries.map((entry) => entry.kind),
      [
        "stream-started",
        "player-attached",
        "buffering-started",
        "slow-segment",
        "slow-fragment",
        "buffering-ended",
        "stream-ended",
        "request-failed",
        "recovery",
      ],
    );
  });

  it("splits a slow segment's time and says why a stream ended", () => {
    const slow = timeline.entries.find((entry) => entry.kind === "slow-segment");
    const ended = timeline.entries.find((entry) => entry.kind === "stream-ended");

    assert.strictEqual(
      slow?.summary,
      "Segment 12 took 32.9 s: encoder 31.0 s, disk 3 ms, network 1.9 s",
    );
    assert.include(ended?.summary, "STREAM_IDLE_SECONDS");
    assert.strictEqual(slow?.details["encoderWaitMs"], 31_000);
    assert.isUndefined(slow?.details["userId"]);
  });

  it("totals stalls, slow loads, failures, and recoveries", () => {
    assert.deepStrictEqual(timeline.counts, {
      streams: 1,
      stalls: 1,
      stalledMs: 31_000,
      slowSegments: 1,
      failedRequests: 1,
      playerErrors: 0,
      recoveries: 1,
      slowFragments: 1,
      droppedFrames: 0,
    });
    assert.strictEqual(timeline.platform, "web");
  });

  it("never measures drift and names no gap when both sides reported", () => {
    assert.strictEqual(timeline.drift.status, "not-measured");
    assert.deepStrictEqual(timeline.missing, []);
  });

  it("names the evidence a session without player reports lacks", () => {
    const serverOnly = Option.getOrThrow(
      timelineOf(
        SESSION,
        RECORDS.filter((entry) => entry.annotations["source"] !== "player"),
        true,
      ),
    );

    assert.isTrue(serverOnly.truncated);
    assert.isTrue(serverOnly.missing.some((gap) => gap.includes("player sent no diagnostics")));
    assert.isTrue(serverOnly.missing.some((gap) => gap.includes("latest records")));
  });

  it("tells how long the player took to start, and never counts that as a stall", () => {
    const started = Option.getOrThrow(
      timelineOf(
        SESSION,
        [
          record(LogEvent.streamStarted, 0, { streamId: "s1", mode: "remux" }),
          player(
            LogEvent.startupEnded,
            15_000,
            12_000,
            { streamId: "s1", positionSeconds: 0, startupMs: 12_000, endedBy: "paused" },
            "WARN",
          ),
          player(LogEvent.startupEnded, 20_000, 18_000, {
            streamId: "s1",
            positionSeconds: 0,
            startupMs: 300,
            endedBy: "playing",
          }),
        ],
        false,
      ),
    );

    assert.deepStrictEqual(
      started.entries.map((entry) => [entry.kind, entry.source, entry.summary]),
      [
        ["stream-started", "server", "HLS stream started (remux)"],
        ["startup", "player", "Waited 12.0 s to start, then the viewer paused"],
        ["startup", "player", "Started playing after 300 ms"],
      ],
    );
    assert.strictEqual(started.counts.stalls, 0);
    assert.strictEqual(started.counts.stalledMs, 0);
  });

  it("says what LOG_LEVEL above info leaves out, instead of guessing why", () => {
    const warnings = Option.getOrThrow(
      timelineOf(
        SESSION,
        RECORDS.filter((entry) => entry.level !== "INFO" && entry.level !== "DEBUG"),
        false,
        "Warn",
      ),
    );

    assert.isTrue(warnings.missing.some((gap) => gap.includes("LOG_LEVEL=warn")));
    assert.isFalse(warnings.missing.some((gap) => gap.includes("No stream started")));
    assert.isFalse(warnings.missing.some((gap) => gap.includes("player sent no diagnostics")));
  });

  it("counts a stream whose encoder failed before it started, and says so", () => {
    const failed = Option.getOrThrow(
      timelineOf(
        SESSION,
        [
          record(LogEvent.encoderFailed, 3000, { streamId: "s9", mode: "transcode-qsv" }, "WARN"),
          record(LogEvent.streamEnded, 3010, { streamId: "s9", reason: "failed" }),
        ],
        false,
      ),
    );

    assert.strictEqual(failed.counts.streams, 1);
    assert.isFalse(failed.missing.some((gap) => gap.includes("No stream started")));
    assert.isTrue(
      failed.missing.some((gap) => gap.startsWith("Stream s9 never started: the encoder failed")),
      failed.missing.join("\n"),
    );
  });

  it("counts the failed requests past the session's budget", () => {
    const flooded = Option.getOrThrow(
      timelineOf(
        SESSION,
        [
          ...RECORDS,
          record(LogEvent.requestFailuresSuppressed, 50_000, { failures: 70 }, "WARN"),
          record(LogEvent.requestFailuresSuppressed, 80_000, { failures: 5 }, "WARN"),
        ],
        false,
      ),
    );

    assert.isTrue(flooded.missing.some((gap) => gap.startsWith("75 more failed requests")));
  });

  it("says why an encoder stopped, restarted, or could not restart, and why a stream ended", () => {
    const lived = Option.getOrThrow(
      timelineOf(
        SESSION,
        [
          record(LogEvent.streamStarted, 0, { streamId: "s2", mode: "transcode-software" }),
          record(LogEvent.streamReleased, 61_000, {
            streamId: "s2",
            generation: 1,
            segment: 14,
            liveness: "paused",
            inFlight: 0,
            lastRequestAgeMs: 61_200,
            lastProgressAgeMs: 58_000,
          }),
          record(LogEvent.streamResumed, 211_000, {
            streamId: "s2",
            generation: 1,
            segment: 15,
            fromSeconds: 140,
            releasedForMs: 150_000,
          }),
          record(LogEvent.streamEnded, 2_400_000, {
            streamId: "s2",
            reason: "session-ended",
            liveness: "ended",
            inFlight: 0,
            lastRequestAgeMs: 2_280_000,
            lastProgressAgeMs: null,
          }),
        ],
        false,
      ),
    );

    assert.deepStrictEqual(
      lived.entries.map((entry) => [entry.kind, entry.level, entry.summary]),
      [
        ["stream-started", "INFO", "HLS stream started (transcode-software)"],
        [
          "stream-moved",
          "INFO",
          "Encoder stopped: paused, last request 1.0 min ago, last progress 58.0 s ago; the stream stays and restarts on the next request",
        ],
        [
          "stream-moved",
          "INFO",
          "Encoder restarted at 0:02:20 (generation 1) after 2.5 min stopped",
        ],
        [
          "stream-ended",
          "INFO",
          "Stream ended: session-ended, the playback session ended (ended, last request 38.0 min ago, last progress never)",
        ],
      ],
    );
  });

  it("names the slots a refused restart found taken, and why the stream then ended", () => {
    for (const [slots, summary] of [
      [
        "remux",
        "Encoder not restarted for segment 4: every remux slot is taken; the stream closes and the player negotiates again",
      ],
      [
        "transcode",
        "Encoder not restarted for segment 4: every transcode slot is taken; the stream closes and the player negotiates again",
      ],
    ] as const) {
      const refused = Option.getOrThrow(
        timelineOf(
          SESSION,
          [
            record(
              LogEvent.resumeRefused,
              0,
              {
                streamId: "s3",
                generation: 1,
                segment: 4,
                reason: "TranscodeCapacityReached",
                slots,
              },
              "WARN",
            ),
            record(LogEvent.streamEnded, 10, {
              streamId: "s3",
              reason: "resume-refused",
              liveness: "requesting",
              inFlight: 1,
              lastRequestAgeMs: 0,
              lastProgressAgeMs: null,
            }),
          ],
          false,
        ),
      );

      assert.deepStrictEqual(
        refused.entries.map((entry) => entry.summary),
        [
          summary,
          "Stream ended: resume-refused, its player came back while no slot or transcode space was free (requesting, last request 0 ms ago, last progress never)",
        ],
      );
    }
  });

  it("is none for records without playback events", () => {
    assert.isTrue(Option.isNone(timelineOf(SESSION, [record("Sent HTTP response", 0, {})], false)));
  });
});

const timelineWith = (records: ReadonlyArray<LogRecord>, logLevel: "Info" | "Warn" = "Info") =>
  Option.getOrThrow(
    timelineOf(
      SESSION,
      [record(LogEvent.streamStarted, 0, { streamId: "s1", mode: "remux" }), ...records],
      false,
      logLevel,
    ),
  );

const streamLoad = (streamId: string, index: number, occurredMs: number, elapsedMs: number) =>
  player(
    LogEvent.fragmentLoaded,
    occurredMs + 500,
    occurredMs,
    {
      streamId,
      segment: index,
      elapsedMs,
      firstByteMs: 20,
      bytes: 400_000,
      index,
      startup: true,
    },
    elapsedMs >= 1000 ? "WARN" : "INFO",
  );

const startupEnded = (streamId: string | null, occurredMs: number) =>
  player(LogEvent.startupEnded, occurredMs + 500, occurredMs, {
    streamId,
    positionSeconds: 0,
    startupMs: 400,
    endedBy: "playing",
  });

describe("startup and audio evidence", () => {
  it("splits a startup from the play intent, and keeps a startup without stages as it was", () => {
    const timeline = timelineWith([
      player(LogEvent.startupEnded, 3000, 1200, {
        streamId: "s1",
        positionSeconds: 0,
        startupMs: 1200,
        endedBy: "playing",
        negotiatedMs: 400,
        manifestLoadedMs: 600,
        firstFragmentMs: 1100,
        firstFrameMs: 1900,
      }),
      player(LogEvent.startupEnded, 9000, 8000, {
        streamId: "s1",
        positionSeconds: 0,
        startupMs: 2500,
        endedBy: "paused",
        negotiatedMs: 300,
      }),
      player(LogEvent.startupEnded, 20_000, 18_000, {
        streamId: "s1",
        positionSeconds: 0,
        startupMs: 300,
        endedBy: "playing",
      }),
    ]);

    assert.deepStrictEqual(
      timeline.entries.filter((entry) => entry.kind === "startup").map((entry) => entry.summary),
      [
        "Started playing after 1.2 s; from play intent: negotiated 400 ms, playlist 600 ms, first segment 1.1 s, first frame 1.9 s",
        "Waited 2.5 s to start, then the viewer paused; from play intent: negotiated 300 ms",
        "Started playing after 300 ms",
      ],
    );
  });

  it("folds the session's first segment loads into its startup, slow ones included", () => {
    const load = (index: number, occurredMs: number, elapsedMs: number) =>
      player(
        LogEvent.fragmentLoaded,
        occurredMs + 500,
        occurredMs,
        {
          streamId: "s1",
          segment: index,
          elapsedMs,
          firstByteMs: 20,
          bytes: 400_000,
          index,
          startup: true,
        },
        elapsedMs >= 1000 ? "WARN" : "INFO",
      );

    const timeline = timelineWith([
      load(0, 900, 240),
      load(1, 1000, 1400),
      load(2, 1500, 60),
      player(LogEvent.startupEnded, 3000, 1600, {
        streamId: "s1",
        positionSeconds: 0,
        startupMs: 1200,
        endedBy: "playing",
      }),
      load(3, 2000, 80),
    ]);

    const startups = timeline.entries.filter((entry) => entry.kind === "startup");

    assert.deepStrictEqual(
      startups.map((entry) => entry.summary),
      [
        "Started playing after 1.2 s; first 3 segment loads: median 240 ms, slowest 1.4 s (segment 1)",
      ],
    );
    assert.deepStrictEqual(
      startups[0]?.details["segmentLoads"],
      [0, 1, 2].map((index) => ({
        index,
        segment: index,
        elapsedMs: [240, 1400, 60][index] ?? 0,
        firstByteMs: 20,
        bytes: 400_000,
      })),
    );
    assert.strictEqual(timeline.counts.slowFragments, 1);
    assert.strictEqual(
      timeline.entries.filter((entry) => entry.kind === "slow-fragment").length,
      1,
    );
  });

  it("keeps loads after the startup, or from another stream, out of it", () => {
    const seeked = timelineWith([
      streamLoad("s1", 0, 900, 120),
      streamLoad("s1", 1, 1000, 80),
      startupEnded("s1", 1600),
      streamLoad("s1", 2, 6000, 4000),
      streamLoad("s1", 3, 9000, 3000),
    ]);

    const switched = timelineWith([startupEnded(null, 1600), streamLoad("s2", 0, 3600, 90)]);

    const startupOf = (timeline: ReturnType<typeof timelineWith>) =>
      timeline.entries.find((entry) => entry.kind === "startup");

    assert.strictEqual(
      startupOf(seeked)?.summary,
      "Started playing after 400 ms; first 2 segment loads: median 100 ms, slowest 120 ms (segment 0)",
    );
    assert.strictEqual(startupOf(switched)?.summary, "Started playing after 400 ms");
    assert.isUndefined(startupOf(switched)?.details["segmentLoads"]);
    assert.isFalse(switched.missing.some((gap) => gap.includes("during startup")));
  });

  it("says so when segment loads came in but no startup ended", () => {
    const timeline = timelineWith([
      player(LogEvent.fragmentLoaded, 2000, 900, {
        streamId: "s1",
        segment: 0,
        elapsedMs: 240,
        firstByteMs: 80,
        bytes: 400_000,
        index: 0,
        startup: true,
      }),
    ]);

    assert.isFalse(timeline.entries.some((entry) => entry.kind === "startup"));
    assert.isTrue(timeline.missing.some((gap) => gap.includes("1 segment load during startup")));
  });

  it("counts no routine token renewal as a recovery, though the timeline shows it", () => {
    const timeline = timelineWith([
      player(LogEvent.recovery, 2000, 900, {
        streamId: "s1",
        action: "renew-token",
        reason: "Renewed the playback token 300 s before it expired",
      }),
      player(
        LogEvent.recovery,
        3000,
        1900,
        { streamId: "s1", action: "renegotiate", reason: "Stream gone" },
        "WARN",
      ),
    ]);

    assert.strictEqual(timeline.counts.recoveries, 1);
    assert.strictEqual(timeline.entries.filter((entry) => entry.kind === "recovery").length, 2);
  });

  it("tells the audio a player attached with, when the player knows it", () => {
    const timeline = timelineWith([
      player(LogEvent.playerAttached, 1000, 100, {
        streamId: "s1",
        mode: "remux",
        engine: "hls.js",
        audioCodec: "aac",
        audioChannels: 2,
        audioLanguage: "eng",
      }),
      player(LogEvent.playerAttached, 2000, 200, {
        streamId: "s1",
        mode: "remux",
        engine: "hls.js",
        audioCodec: "eac3",
        audioChannels: 6,
        audioLanguage: null,
      }),
      player(LogEvent.playerAttached, 3000, 300, {
        streamId: "s1",
        mode: "remux",
        engine: "hls.js",
      }),
    ]);

    assert.deepStrictEqual(
      timeline.entries
        .filter((entry) => entry.kind === "player-attached")
        .map((entry) => entry.summary),
      [
        "Player attached: hls.js on web, remux; audio aac 2 ch, eng",
        "Player attached: hls.js on web, remux; audio eac3 6 ch",
        "Player attached: hls.js on web, remux",
      ],
    );
  });
});

describe("audio/video drift", () => {
  const window = (occurredMs: number, samples: number, medianMs: number, worstMs: number) =>
    player(LogEvent.driftSampled, occurredMs + 500, occurredMs, {
      streamId: "s1",
      samples,
      medianMs,
      worstMs,
    });

  const attached = player(LogEvent.playerAttached, 5000, 100, {
    streamId: "s1",
    mode: "remux",
    engine: "hls.js",
  });

  const windows = [
    window(60_000, 6, -12, -41),
    window(120_000, 6, -10, 25),
    window(150_000, 3, -15, -15),
  ];

  it("measures drift from the player's windows: the median of their medians, and the worst", () => {
    const odd = timelineWith([attached, ...windows]);

    const even = timelineWith([attached, window(60_000, 6, -10, 30), window(120_000, 2, -20, -22)]);

    assert.deepStrictEqual(odd.drift, {
      status: "measured",
      method: "video-frame-vs-media-clock",
      samples: 15,
      medianMs: -12,
      worstMs: -41,
    });
    assert.deepStrictEqual(even.drift, {
      status: "measured",
      method: "video-frame-vs-media-clock",
      samples: 8,
      medianMs: -15,
      worstMs: 30,
    });
    assert.deepStrictEqual(
      odd.entries.map((entry) => entry.kind),
      ["stream-started", "player-attached"],
    );
  });

  it("counts a player that sent only drift windows as a player that reported", () => {
    const timeline = timelineWith([window(60_000, 6, -5, -9)]);

    assert.strictEqual(timeline.drift.status, "measured");
    assert.isFalse(timeline.missing.some((gap) => gap.includes("player sent no diagnostics")));
  });

  it("says why drift is not measured, from the evidence there is", () => {
    const reasonOf = (timeline: ReturnType<typeof timelineWith>): string =>
      timeline.drift.status === "not-measured" ? timeline.drift.reason : "measured";

    const ios = timelineWith([
      player(LogEvent.playerAttached, 5000, 100, {
        streamId: "s1",
        mode: "remux",
        engine: "avplayer",
        platform: "ios",
      }),
    ]);

    assert.include(reasonOf(ios), "AVPlayer");
    assert.include(reasonOf(timelineWith([attached])), "browser sent no drift samples");
    assert.include(reasonOf(timelineWith([])), "player sent no diagnostics");
    assert.include(reasonOf(timelineWith([], "Warn")), "LOG_LEVEL=warn");
  });

  it("hands a measured drift to a client before it as not measured, with its numbers", () => {
    const measured = timelineWith([attached, ...windows]).drift;

    assert.deepStrictEqual(driftFor(measured, false), {
      status: "not-measured",
      reason:
        "This client predates measured drift; update it to see it. The player sampled it 15 times: median -12 ms, worst -41 ms (video frame against the media clock; negative means the picture trails the sound).",
    });
    assert.deepStrictEqual(driftFor(measured, true), measured);

    const unmeasured = timelineWith([attached]).drift;

    assert.deepStrictEqual(driftFor(unmeasured, false), unmeasured);
  });
});

describe("diagnosed sessions", () => {
  it("names the accounts the records belong to", () => {
    assert.deepStrictEqual([...ownersOf(RECORDS)], ["user_a"]);
  });

  it("lists sessions newest first with their warnings", () => {
    const other: LogRecord = {
      message: LogEvent.streamStarted,
      level: "INFO",
      timestamp: new Date(BASE + 90_000).toISOString(),
      annotations: { sessionId: "session_b", userId: "user_b" },
    };

    const sessions = sessionsOf([...RECORDS, other]);

    assert.deepStrictEqual(
      sessions.map(
        (session) => `${session.sessionId} ${String(session.userId)} ${String(session.warnings)}`,
      ),
      ["session_b user_b 0", "session_a user_a 5"],
    );
    assert.strictEqual(sessions[1]?.platform, "web");
  });
});
