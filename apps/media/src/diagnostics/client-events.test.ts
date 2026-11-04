import { assert, describe, it } from "@effect/vitest";
import {
  type ClientDiagnosticEvent,
  ClientDiagnosticsRequest,
  type LogRecord,
  PlayerObservation,
} from "@media/contracts/diagnostics";
import { PlaybackSessionId } from "@media/contracts/ids";
import { StreamId } from "@media/contracts/media-playback";
import {
  Duration,
  Effect,
  Layer,
  Logger,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";

import { decodeRecord } from "../logging/log-query.ts";
import * as ConvexSessionReports from "../convex/convex-session-reports.ts";
import * as EndedSessions from "../playback/ended-sessions.ts";
import * as PlaybackToken from "../playback/playback-token.ts";
import * as StreamOwners from "../playback/stream-owners.ts";
import { signTestToken, testConfigLayer } from "../testing/test-config.ts";
import * as TestConvex from "../testing/test-convex.ts";
import * as ClientDiagnostics from "./client-events.ts";
import { LogEvent } from "./log-events.ts";
import { sessionsOf, timelineOf } from "./timeline.ts";

const recorderLayer = ClientDiagnostics.layer.pipe(
  Layer.provideMerge(PlaybackToken.layer),
  Layer.provideMerge(EndedSessions.layer.pipe(Layer.provide(ConvexSessionReports.layer))),
  Layer.provideMerge(StreamOwners.layer),
  Layer.provideMerge(TestConvex.layer),
  Layer.provide(testConfigLayer({})),
  Layer.orDie,
);

const recording = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ClientDiagnostics.Service | EndedSessions.Service | StreamOwners.Service | TestConvex.Service
  >,
) =>
  Effect.gen(function* () {
    const logged: Array<LogRecord> = [];

    const capture = Logger.map(Logger.formatJson, (line) => {
      logged.push(...Option.toArray(decodeRecord(line)));
    });

    const context = yield* Layer.build(Layer.merge(recorderLayer, Logger.layer([capture])));
    const result = yield* effect.pipe(Effect.provideContext(context));

    return { result, logged };
  }).pipe(Effect.scoped);

const batch = (
  events: ReadonlyArray<ClientDiagnosticEvent>,
  sid = "session_test",
): ClientDiagnosticsRequest => ({
  token: Redacted.make(signTestToken({ fid: "file_1", sid })),
  platform: "web",
  events,
});

const stall: ClientDiagnosticEvent = {
  ageMs: 2000,
  observation: PlayerObservation.cases.BufferingEnded.make({
    positionSeconds: 70,
    bufferedAheadSeconds: 0,
    durationMs: 31_000,
    endedBy: "playing",
  }),
};

const startup = (durationMs: number): ClientDiagnosticEvent => ({
  ageMs: 0,
  observation: PlayerObservation.cases.StartupEnded.make({
    positionSeconds: 0,
    durationMs,
    endedBy: "playing",
  }),
});

const fragment = (durationMs: number, index?: number): ClientDiagnosticEvent => {
  const loaded = { segment: index ?? 99, durationMs, firstByteMs: 20, bytes: 1000 };

  return {
    ageMs: 0,
    observation: PlayerObservation.cases.FragmentLoaded.make(
      index === undefined ? loaded : { ...loaded, index },
    ),
  };
};

const recovery = (action: "renew-token" | "renegotiate"): ClientDiagnosticEvent => ({
  ageMs: 0,
  observation: PlayerObservation.cases.Recovery.make({ action, reason: "token expiring" }),
});

const recorded = (events: ReadonlyArray<ClientDiagnosticEvent>) =>
  Effect.map(
    recording(
      Effect.flatMap(ClientDiagnostics.Service, (recorder) => recorder.record(batch(events))),
    ),
    ({ logged }) => logged,
  );

const timelineFrom = (logged: ReadonlyArray<LogRecord>) =>
  Option.getOrThrow(timelineOf(PlaybackSessionId.make("session_test"), logged, false));

describe("client diagnostics", () => {
  it.live("logs each event under its player name with the verified session and account", () =>
    Effect.gen(function* () {
      const before = Date.now();

      const { logged } = yield* recording(
        Effect.flatMap(ClientDiagnostics.Service, (recorder) =>
          recorder.record(
            batch([
              {
                ageMs: 5000,
                observation: PlayerObservation.cases.Attached.make({
                  mode: "remux",
                  engine: "hls.js",
                }),
              },
              stall,
              {
                ageMs: 0,
                observation: PlayerObservation.cases.FragmentLoaded.make({
                  segment: 13,
                  durationMs: 90,
                  firstByteMs: 20,
                  bytes: 1000,
                }),
              },
              {
                ageMs: 0,
                observation: PlayerObservation.cases.PlayerError.make({
                  source: "hls.js",
                  kind: "fragLoadError",
                  detail: "HTTP 404 for https://media/x.m4s?token=v1.abc.def",
                  fatal: true,
                  status: 404,
                }),
              },
            ]),
          ),
        ),
      );

      assert.deepStrictEqual(
        logged.map((entry) => [entry.message, entry.level]),
        [
          [LogEvent.playerAttached, "INFO"],
          [LogEvent.bufferingEnded, "WARN"],
          [LogEvent.playerError, "ERROR"],
        ],
      );

      const ended = logged[1]?.annotations ?? {};

      assert.deepInclude(ended, {
        sessionId: "session_test",
        userId: "user_test",
        platform: "web",
        source: "player",
        stalledMs: 31_000,
      });

      const reported = ended["occurredAt"];
      const occurred = Predicate.isString(reported) ? Date.parse(reported) : Number.NaN;

      assert.isAtLeast(occurred, before - 2000);
      assert.isAtMost(occurred, Date.now() - 2000);
    }),
  );

  it.live("logs a startup as no stall, and a slow one as a warning", () =>
    Effect.gen(function* () {
      const { logged } = yield* recording(
        Effect.flatMap(ClientDiagnostics.Service, (recorder) =>
          recorder.record(batch([startup(300), startup(12_000)])),
        ),
      );

      assert.deepStrictEqual(
        logged.map((entry) => [
          entry.message,
          entry.level,
          entry.annotations["startupMs"],
          entry.annotations["endedBy"],
          entry.annotations["stalledMs"],
        ]),
        [
          [LogEvent.startupEnded, "INFO", 300, "playing", undefined],
          [LogEvent.startupEnded, "WARN", 12_000, "playing", undefined],
        ],
      );
    }),
  );

  it.live("takes the last events of a session that has already ended", () =>
    Effect.gen(function* () {
      const { logged } = yield* recording(
        Effect.gen(function* () {
          yield* (yield* TestConvex.Service).end("session_test");

          assert.isTrue(
            yield* (yield* EndedSessions.Service).isEnded(PlaybackSessionId.make("session_test")),
          );
          yield* (yield* ClientDiagnostics.Service).record(batch([stall]));
        }),
      );

      assert.strictEqual(logged.length, 1);
    }),
  );

  it.live("refuses a token it did not sign", () =>
    Effect.gen(function* () {
      const { result } = yield* recording(
        Effect.flatMap(ClientDiagnostics.Service, (recorder) =>
          recorder
            .record({
              token: Redacted.make("v1.forged.token"),
              platform: "web",
              events: [stall],
            })
            .pipe(Effect.flip),
        ),
      );

      assert.isTrue(Predicate.isTagged(result, "PlaybackTokenInvalid"));
    }),
  );

  it.live("files an event under its stream only when the stream is the session's", () =>
    Effect.gen(function* () {
      const own = StreamId.make("AAAAAAAAAAAAAAAAAAAAAA");
      const ended = StreamId.make("BBBBBBBBBBBBBBBBBBBBBB");
      const others = StreamId.make("CCCCCCCCCCCCCCCCCCCCCC");

      const { logged } = yield* recording(
        Effect.gen(function* () {
          const owners = yield* StreamOwners.Service;

          yield* owners.opened(own, PlaybackSessionId.make("session_test"));
          yield* owners.opened(ended, PlaybackSessionId.make("session_test"));
          yield* owners.closed(ended);
          yield* owners.opened(others, PlaybackSessionId.make("session_other"));

          yield* (yield* ClientDiagnostics.Service).record(
            batch(
              [own, ended, others].map((streamId) => ({
                ageMs: stall.ageMs,
                streamId,
                observation: stall.observation,
              })),
            ),
          );
        }),
      );

      assert.deepStrictEqual(
        logged.map((entry) => [
          entry.annotations["streamId"],
          entry.annotations["claimedStreamId"],
        ]),
        [
          [own, null],
          [ended, null],
          [null, others],
        ],
      );
    }),
  );

  it.live("limits an account across its sessions", () =>
    Effect.gen(function* () {
      const hundred = Array.from({ length: 100 }, () => stall);

      const { result, logged } = yield* recording(
        Effect.gen(function* () {
          const recorder = yield* ClientDiagnostics.Service;

          for (const session of ["one", "one", "two", "two"]) {
            yield* recorder.record(batch(hundred, session));
          }

          return yield* recorder.record(batch(hundred, "three")).pipe(Effect.flip);
        }),
      );

      assert.isTrue(Predicate.isTagged(result, "DiagnosticsRateLimited"));
      assert.strictEqual(logged.length, 400);
    }),
  );

  it.effect("lets four players of one account each report at a session's full rate", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now());

      const { result } = yield* recording(
        Effect.gen(function* () {
          const recorder = yield* ClientDiagnostics.Service;
          let refused = 0;

          for (let second = 0; second < 600; second += 1) {
            for (const session of ["tv", "phone", "tablet", "laptop"]) {
              const sent = yield* recorder
                .record(batch([stall, stall], session))
                .pipe(Effect.result);

              if (Result.isFailure(sent)) refused += 1;
            }

            yield* TestClock.adjust(Duration.seconds(1));
          }

          return refused;
        }),
      );

      assert.strictEqual(result, 0);
    }),
  );

  it.live("limits each session to its budget, and only that session", () =>
    Effect.gen(function* () {
      const hundred = Array.from({ length: 100 }, () => stall);

      const { result } = yield* recording(
        Effect.gen(function* () {
          const recorder = yield* ClientDiagnostics.Service;

          for (let sent = 0; sent < 3; sent += 1) yield* recorder.record(batch(hundred));

          const refused = yield* recorder.record(batch(hundred)).pipe(Effect.flip);

          yield* recorder.record(batch([stall], "session_other"));

          return refused;
        }),
      );

      assert.isTrue(Predicate.isTagged(result, "DiagnosticsRateLimited"));
    }),
  );
  it.live("keeps the session's first segment loads as startup, and later ones only when slow", () =>
    Effect.gen(function* () {
      const logged = yield* recorded([
        fragment(90, 0),
        fragment(90, 11),
        fragment(90, 12),
        fragment(1500, 5),
        fragment(1500, 40),
        fragment(90),
      ]);

      assert.deepStrictEqual(
        logged.map((entry) => [
          entry.message,
          entry.level,
          entry.annotations["index"],
          entry.annotations["startup"],
        ]),
        [
          [LogEvent.fragmentLoaded, "INFO", 0, true],
          [LogEvent.fragmentLoaded, "INFO", 11, true],
          [LogEvent.fragmentLoaded, "WARN", 5, true],
          [LogEvent.fragmentLoaded, "WARN", 40, false],
        ],
      );

      const timeline = timelineFrom(logged);

      assert.deepStrictEqual(
        timeline.entries.map((entry) => [entry.kind, entry.level]),
        [
          ["slow-fragment", "WARN"],
          ["slow-fragment", "WARN"],
        ],
      );
      assert.strictEqual(timeline.counts.slowFragments, 2);
      assert.isTrue(timeline.missing.some((gap) => gap.includes("3 segment loads during startup")));
    }),
  );

  it.live("admits each startup index once a session, whatever index the player claims", () =>
    Effect.gen(function* () {
      const { logged } = yield* recording(
        Effect.flatMap(ClientDiagnostics.Service, (recorder) =>
          Effect.gen(function* () {
            yield* recorder.record(batch([fragment(90, 0), fragment(90, 0), fragment(90, 0)]));
            yield* recorder.record(
              batch(Array.from({ length: 15 }, (_, index) => fragment(90, index + 1))),
            );
            yield* recorder.record(batch([fragment(90, 0)], "session_other"));
          }),
        ),
      );

      const admitted = (sessionId: string) =>
        logged
          .filter(
            (entry) =>
              entry.annotations["sessionId"] === sessionId && entry.annotations["startup"] === true,
          )
          .map((entry) => entry.annotations["index"]);

      assert.deepStrictEqual(
        admitted("session_test"),
        Array.from({ length: 12 }, (_, index) => index),
      );
      assert.deepStrictEqual(admitted("session_other"), [0]);
    }),
  );

  it.live("logs a routine token renewal as a recovery that is no warning", () =>
    Effect.gen(function* () {
      const logged = yield* recorded([recovery("renew-token"), recovery("renegotiate")]);

      assert.deepStrictEqual(
        logged.map((entry) => [entry.message, entry.level, entry.annotations["action"]]),
        [
          [LogEvent.recovery, "INFO", "renew-token"],
          [LogEvent.recovery, "WARN", "renegotiate"],
        ],
      );
      assert.strictEqual(timelineFrom(logged).counts.recoveries, 1);
      assert.strictEqual(sessionsOf(logged)[0]?.warnings, 1);
    }),
  );

  it.live("logs the attached audio, the startup stages, and drift samples", () =>
    Effect.gen(function* () {
      const logged = yield* recorded([
        {
          ageMs: 0,
          observation: PlayerObservation.cases.Attached.make({
            mode: "remux",
            engine: "hls.js",
            audio: { codec: "eac3", channels: 6 },
          }),
        },
        {
          ageMs: 0,
          observation: PlayerObservation.cases.StartupEnded.make({
            positionSeconds: 0,
            durationMs: 1200,
            endedBy: "playing",
            stages: { negotiatedMs: 400, firstFrameMs: 1900 },
          }),
        },
        {
          ageMs: 0,
          observation: PlayerObservation.cases.DriftSampled.make({
            samples: 6,
            medianMs: -12,
            worstMs: -41,
          }),
        },
      ]);

      assert.deepStrictEqual(
        logged.map((entry) => [entry.message, entry.level]),
        [
          [LogEvent.playerAttached, "INFO"],
          [LogEvent.startupEnded, "INFO"],
          [LogEvent.driftSampled, "INFO"],
        ],
      );
      assert.deepInclude(logged[0]?.annotations, {
        audioCodec: "eac3",
        audioChannels: 6,
        audioLanguage: null,
      });
      assert.deepInclude(logged[1]?.annotations, { negotiatedMs: 400, firstFrameMs: 1900 });
      assert.notProperty(logged[1]?.annotations, "manifestLoadedMs");
      assert.deepInclude(logged[2]?.annotations, { samples: 6, medianMs: -12, worstMs: -41 });
    }),
  );

  it.live(
    "takes a batch from a player before startup stages and drift, and logs it as before",
    () =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeEffect(Schema.toCodecJson(ClientDiagnosticsRequest))({
          token: signTestToken({ fid: "file_1", sid: "session_test" }),
          platform: "web",
          events: [
            { ageMs: 0, observation: { _tag: "Attached", mode: "remux", engine: "hls.js" } },
            {
              ageMs: 0,
              observation: {
                _tag: "StartupEnded",
                positionSeconds: 0,
                durationMs: 300,
                endedBy: "playing",
              },
            },
            {
              ageMs: 0,
              observation: {
                _tag: "FragmentLoaded",
                segment: 0,
                durationMs: 90,
                firstByteMs: 20,
                bytes: 1000,
              },
            },
            {
              ageMs: 0,
              observation: {
                _tag: "FragmentLoaded",
                segment: 1,
                durationMs: 1500,
                firstByteMs: 20,
                bytes: 1000,
              },
            },
            { ageMs: 0, observation: { _tag: "Recovery", action: "renegotiate", reason: "gone" } },
          ],
        });

        const { logged } = yield* recording(
          Effect.flatMap(ClientDiagnostics.Service, (recorder) => recorder.record(request)),
        );

        assert.deepStrictEqual(
          logged.map((entry) => [entry.message, entry.level]),
          [
            [LogEvent.playerAttached, "INFO"],
            [LogEvent.startupEnded, "INFO"],
            [LogEvent.fragmentLoaded, "WARN"],
            [LogEvent.recovery, "WARN"],
          ],
        );

        const added = ["audioCodec", "negotiatedMs", "firstFrameMs", "index", "worstMs"];

        assert.isTrue(
          logged.every((entry) => added.every((key) => !(key in entry.annotations))),
          JSON.stringify(logged.map((entry) => entry.annotations)),
        );
      }),
  );
});
