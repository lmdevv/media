import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { ClientDiagnosticsRequest, PlayerObservation } from "@media/contracts/diagnostics";
import type { NegotiateResponse } from "@media/contracts/media-playback";
import { StreamId } from "@media/contracts/media-playback";
import type { AudioStream } from "@media/contracts/models/catalog";
import { StartedPlayback } from "@media/contracts/models/playback";
import { Effect, Exit, Layer, Option, Predicate, Redacted, Schema, Scope } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MediaOrigin } from "./media-http";
import type { Playback } from "./playback";
import type { PlayerEvent, PlayerPort } from "./room-sync/player-port";
import type { FrameCounts } from "./player-diagnostics";
import { attached, reportDiagnostics } from "./player-diagnostics";
import { makeFakePlayer } from "./testing/fake-player";

const batches: Array<ClientDiagnosticsRequest> = [];

const decodeBatch = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(ClientDiagnosticsRequest)),
);

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";

  request.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });

  request.on("end", () => {
    if (request.url === "/api/playback/diagnostics") batches.push(decodeBatch(body));
    response.writeHead(204).end();
  });
});

let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (address === null || Predicate.isString(address)) throw new Error("The server is not on TCP");

  base = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  batches.length = 0;
});

interface AudioChoice {
  readonly stream: NegotiateResponse["audio"];
  readonly tracks: ReadonlyArray<AudioStream>;
}

const playbackAt = (
  mediaBaseUrl: string,
  token = "v1.payload.signature",
  sessionId = "session-1",
  audio: AudioChoice = { stream: undefined, tracks: [] },
): Playback => ({
  started: Schema.decodeSync(StartedPlayback)({
    sessionId,
    titleId: "title-1",
    episodeId: null,
    episode: null,
    file: {
      id: "file-1",
      titleId: "title-1",
      episodeId: null,
      versionName: null,
      sizeBytes: 1_000,
      probe: {
        container: "mkv",
        durationMs: 600_000,
        bitRate: null,
        video: [],
        audio: audio.tracks,
        subtitles: [],
      },
      externalSubtitles: [],
      hdr: false,
      missing: false,
      trickplay: null,
    },
    token,
    tokenExpiresAt: 1_760_000_000_000,
    mediaBaseUrl,
    resumePositionMs: 0,
  }),
  stream: {
    mode: "remux",
    url: `${mediaBaseUrl}/media/hls/AAAAAAAAAAAAAAAAAAAAAA/1/index.m3u8`,
    streamId: StreamId.make("AAAAAAAAAAAAAAAAAAAAAA"),
    generation: 1,
    startSeconds: 0,
    durationSeconds: 600,
    video: { codec: "h264", width: 1920, height: 1080, dynamicRange: "sdr" },
    audio: audio.stream,
    subtitles: [],
    expiresAt: 1_760_000_000_000,
  },
});

const onTestClock = <A, E>(body: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Layer.build(TestClock.layer()), (context) =>
        body.pipe(Effect.provideContext(context)),
      ),
    ),
  );

const until = (predicate: () => boolean) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        const check = (): void => {
          if (predicate()) resolve();
          else setTimeout(check, 5);
        };

        check();
      }),
  );

const recovery = (reason: string) =>
  PlayerObservation.cases.Recovery.make({ action: "new-session", reason });

const received = () => batches.flatMap((batch) => batch.events);

const renewal = (reason: string) =>
  PlayerObservation.cases.Recovery.make({ action: "renew-token", reason });

const makeElement = () => {
  const listeners = new Set<(event: PlayerEvent) => void>();

  const element = {
    paused: true,
    positionMs: 0,
    emit: (event: PlayerEvent) => {
      for (const listener of listeners) listener(event);
    },
  };

  const player: PlayerPort = {
    positionMs: () => element.positionMs,
    isPaused: () => element.paused,
    isBuffering: () => false,
    playbackRate: () => 1,
    setPlaybackRate: () => undefined,
    seek: () => undefined,
    play: () => Promise.resolve(),
    pause: () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };

  return { element, player };
};

describe("playback diagnostics", () => {
  it("reports a stall with its length, and what the platform recorded", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(60_000);
        const scope = yield* Scope.make();
        const playback = playbackAt(base);

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        recorder.record(PlayerObservation.cases.Attached.make({ mode: "remux", engine: "hls.js" }));
        player.userPlay();
        player.stall();
        yield* TestClock.adjust(31_000);
        player.recover();
        yield* Scope.close(scope, Exit.void);

        expect(received()).toMatchObject([
          { observation: { _tag: "Attached" } },
          { observation: { _tag: "BufferingStarted" } },
          { observation: { _tag: "BufferingEnded" } },
        ]);
        expect(batches.map((batch) => Redacted.value(batch.token))).toContain(
          "v1.payload.signature",
        );
        expect(batches.every((batch) => batch.platform === "web")).toBe(true);
        expect(received().at(-1)).toMatchObject({
          streamId: "AAAAAAAAAAAAAAAAAAAAAA",
          ageMs: 0,
          observation: {
            _tag: "BufferingEnded",
            durationMs: 31_000,
            endedBy: "playing",
            positionSeconds: 60,
          },
        });
      }),
    ));

  it("sends what it recorded within a few seconds, without waiting for the end", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const playback = playbackAt(base);

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        });

        recorder.record(
          PlayerObservation.cases.Attached.make({ mode: "direct", engine: "html-video" }),
        );
        yield* TestClock.adjust(5_000);
        yield* until(() => batches.length > 0);

        expect(received()).toMatchObject([{ ageMs: 5_000, observation: { _tag: "Attached" } }]);
      }),
    ));

  it("samples dropped frames and sends what is left as the scope closes", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const scope = yield* Scope.make();
        const playback = playbackAt(base);
        let frames: FrameCounts = { dropped: 2, decoded: 100 };

        const recorder = yield* reportDiagnostics(player, {
          platform: "ios",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 12,
          frames: () => Option.some(frames),
        }).pipe(Scope.provide(scope));

        yield* TestClock.adjust(5_000);
        yield* until(() => batches.length > 0);
        frames = { dropped: 12, decoded: 1_100 };
        recorder.record(
          PlayerObservation.cases.Recovery.make({
            action: "renegotiate",
            reason: "StreamNotFound",
          }),
        );
        yield* Scope.close(scope, Exit.void);

        expect(received()).toMatchObject([
          { observation: { _tag: "DroppedFrames", dropped: 2, decoded: 100 } },
          { observation: { _tag: "Recovery" } },
          { observation: { _tag: "DroppedFrames", dropped: 10, decoded: 1_000 } },
        ]);
      }),
    ));

  it("sends each event with the token of the playback it happened in, or the one before", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const scope = yield* Scope.make();
        const first = playbackAt(base, "v1.first.session", "session-1");
        const second = playbackAt(base, "v1.second.session", "session-2");
        let playing = Option.some(first);

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => playing,
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        recorder.record(recovery("first"));
        playing = Option.none();
        recorder.record(recovery("between"));
        playing = Option.some(second);
        recorder.record(recovery("second"));
        yield* Scope.close(scope, Exit.void);

        expect(
          batches.map((batch) => [
            Redacted.value(batch.token),
            batch.events.map((event) => event.observation),
          ]),
        ).toMatchObject([
          ["v1.first.session", [{ reason: "first" }, { reason: "between" }]],
          ["v1.second.session", [{ reason: "second" }]],
        ]);
      }),
    ));

  it("notes a token renewal when it happens, with the new token, in the same session only", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const scope = yield* Scope.make();
        const before = playbackAt(base, "v1.old.token", "session-1");
        const renewed = playbackAt(base, "v1.new.token", "session-1");
        const late = playbackAt(base, "v1.late.token", "session-1");
        const next = playbackAt(base, "v1.next.session", "session-2");
        const expiresAt = before.started.tokenExpiresAt;
        let playing = Option.some(before);

        yield* TestClock.setTime(expiresAt - 240_000);

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => playing,
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        recorder.record(recovery("old"));
        yield* TestClock.adjust(10_000);
        recorder.tokenRenewed(before, renewed);
        yield* TestClock.adjust(5_000);
        playing = Option.some(renewed);
        recorder.record(recovery("renewed"));
        yield* TestClock.adjust(255_000);
        recorder.tokenRenewed(renewed, late);
        recorder.tokenRenewed(late, next);
        yield* Scope.close(scope, Exit.void);

        expect(
          batches.flatMap((batch) =>
            batch.events.map((event) => [Redacted.value(batch.token), event.observation]),
          ),
        ).toStrictEqual([
          ["v1.old.token", recovery("old")],
          ["v1.new.token", renewal("Renewed the playback token 230 s before it expired")],
          ["v1.new.token", recovery("renewed")],
          ["v1.late.token", renewal("Renewed the playback token 30 s after it expired")],
        ]);
      }),
    ));

  it("forgets a startup's stages once its session plays, however the startup ended", () =>
    onTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const resumed = playbackAt(base, "v1.resumed.session", "session-1");
        const followed = playbackAt(base, "v1.followed.session", "session-2");
        const unblocked = playbackAt(base, "v1.unblocked.session", "session-3");
        const last = playbackAt(base, "v1.last.session", "session-4");
        const { element, player } = makeElement();
        let playing = Option.some(resumed);

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => playing,
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        recorder.intent();
        element.paused = false;
        element.emit("waiting");
        yield* TestClock.adjust(200);
        recorder.reached("negotiated");
        yield* TestClock.adjust(100);
        element.paused = true;
        element.emit("paused");
        yield* TestClock.adjust(60_000);
        element.paused = false;
        element.emit("playing");

        playing = Option.some(followed);
        element.emit("waiting");
        yield* TestClock.adjust(400);
        element.emit("playing");

        playing = Option.some(unblocked);
        element.paused = true;
        recorder.intent();
        recorder.reached("negotiated");
        yield* TestClock.adjust(30_000);
        element.paused = false;
        element.emit("playing");

        playing = Option.some(last);
        element.emit("waiting");
        yield* TestClock.adjust(600);
        element.emit("playing");
        yield* Scope.close(scope, Exit.void);

        expect(
          batches.map((batch) => [
            Redacted.value(batch.token),
            batch.events.map((event) => event.observation),
          ]),
        ).toStrictEqual([
          [
            "v1.resumed.session",
            [
              PlayerObservation.cases.StartupEnded.make({
                positionSeconds: 0,
                durationMs: 300,
                endedBy: "paused",
                stages: { negotiatedMs: 200 },
              }),
            ],
          ],
          [
            "v1.followed.session",
            [
              PlayerObservation.cases.StartupEnded.make({
                positionSeconds: 0,
                durationMs: 400,
                endedBy: "playing",
              }),
            ],
          ],
          [
            "v1.last.session",
            [
              PlayerObservation.cases.StartupEnded.make({
                positionSeconds: 0,
                durationMs: 600,
                endedBy: "playing",
              }),
            ],
          ],
        ]);
      }),
    ));

  it("forgets an intent made while its session already played, at the next play", () =>
    onTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const played = playbackAt(base, "v1.played.session", "session-1");
        const later = playbackAt(base, "v1.later.session", "session-2");
        const { element, player } = makeElement();
        let playing = Option.some(played);

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => playing,
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        element.paused = false;
        element.emit("playing");
        recorder.intent();
        recorder.reached("negotiated");
        yield* TestClock.adjust(100);
        element.emit("playing");

        yield* TestClock.adjust(3_600_000);
        playing = Option.some(later);
        element.emit("waiting");
        yield* TestClock.adjust(500);
        element.emit("playing");
        yield* Scope.close(scope, Exit.void);

        expect(
          batches.flatMap((batch) => batch.events.map((event) => event.observation)),
        ).toStrictEqual([
          PlayerObservation.cases.StartupEnded.make({
            positionSeconds: 0,
            durationMs: 500,
            endedBy: "playing",
          }),
        ]);
      }),
    ));

  it("measures stages only to the first startup that ends, so a pause starts none over", () =>
    onTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const playback = playbackAt(base);
        const { element, player } = makeElement();

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        recorder.intent();
        element.paused = false;
        element.emit("waiting");
        yield* TestClock.adjust(200);
        recorder.reached("negotiated");
        element.paused = true;
        element.emit("paused");
        yield* TestClock.adjust(30_000);
        element.paused = false;
        element.emit("waiting");
        yield* TestClock.adjust(300);
        recorder.reached("firstFrame");
        element.emit("playing");
        yield* Scope.close(scope, Exit.void);

        expect(
          batches.flatMap((batch) => batch.events.map((event) => event.observation)),
        ).toStrictEqual([
          PlayerObservation.cases.StartupEnded.make({
            positionSeconds: 0,
            durationMs: 200,
            endedBy: "paused",
            stages: { negotiatedMs: 200 },
          }),
          PlayerObservation.cases.StartupEnded.make({
            positionSeconds: 0,
            durationMs: 300,
            endedBy: "playing",
          }),
        ]);
      }),
    ));

  it("names the latest play intent until its session plays", () =>
    onTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const playback = playbackAt(base);
        const { element, player } = makeElement();

        yield* TestClock.setTime(10_000);

        const recorder = yield* reportDiagnostics(player, {
          platform: "ios",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        const before = recorder.intentAt();

        recorder.intent(8_500);
        const given = recorder.intentAt();

        yield* TestClock.adjust(1_000);
        recorder.intent();
        const retried = recorder.intentAt();

        element.paused = false;
        element.emit("waiting");
        yield* TestClock.adjust(300);
        element.paused = true;
        element.emit("paused");
        const paused = recorder.intentAt();

        element.paused = false;
        element.emit("playing");
        const played = recorder.intentAt();

        yield* Scope.close(scope, Exit.void);

        expect([before, given, retried, paused, played]).toStrictEqual([
          Option.none(),
          Option.some(8_500),
          Option.some(11_000),
          Option.some(11_000),
          Option.none(),
        ]);
      }),
    ));

  it("counts no stall while the viewer is paused, however long", () =>
    onTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const playback = playbackAt(base);
        const { element, player } = makeElement();

        yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        element.emit("waiting");
        element.emit("seeked");
        yield* TestClock.adjust(600_000);
        element.paused = false;
        element.emit("playing");
        yield* Scope.close(scope, Exit.void);

        expect(received()).toStrictEqual([]);
      }),
    ));

  it("reports the wait before a session first plays as its startup, never as a stall", () =>
    onTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const first = playbackAt(base, "v1.first.session", "session-1");
        const renegotiated = playbackAt(base, "v1.first.session", "session-1");
        const next = playbackAt(base, "v1.next.session", "session-2");
        const { element, player } = makeElement();
        let playing = Option.some(first);

        yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => playing,
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        element.paused = false;
        element.emit("waiting");
        yield* TestClock.adjust(300);
        element.emit("playing");

        playing = Option.some(renegotiated);
        element.positionMs = 30_000;
        element.emit("waiting");
        yield* TestClock.adjust(2_000);
        element.emit("playing");

        playing = Option.some(next);
        element.positionMs = 0;
        element.emit("waiting");
        yield* TestClock.adjust(12_000);
        element.paused = true;
        element.emit("paused");
        yield* Scope.close(scope, Exit.void);

        expect(
          batches.map((batch) => [
            Redacted.value(batch.token),
            batch.events.map((event) => event.observation),
          ]),
        ).toStrictEqual([
          [
            "v1.first.session",
            [
              PlayerObservation.cases.StartupEnded.make({
                positionSeconds: 0,
                durationMs: 300,
                endedBy: "playing",
              }),
              PlayerObservation.cases.BufferingStarted.make({
                positionSeconds: 30,
                bufferedAheadSeconds: 0,
              }),
              PlayerObservation.cases.BufferingEnded.make({
                positionSeconds: 30,
                bufferedAheadSeconds: 0,
                durationMs: 2_000,
                endedBy: "playing",
              }),
            ],
          ],
          [
            "v1.next.session",
            [
              PlayerObservation.cases.StartupEnded.make({
                positionSeconds: 0,
                durationMs: 12_000,
                endedBy: "paused",
              }),
            ],
          ],
        ]);
      }),
    ));

  it("ends a startup the viewer gave up on when the player closes", () =>
    onTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const playback = playbackAt(base);
        const { element, player } = makeElement();

        yield* reportDiagnostics(player, {
          platform: "ios",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        element.paused = false;
        element.positionMs = 1_200_000;
        element.emit("waiting");
        yield* TestClock.adjust(9_000);
        yield* Scope.close(scope, Exit.void);

        expect(received().map((event) => event.observation)).toStrictEqual([
          PlayerObservation.cases.StartupEnded.make({
            positionSeconds: 1_200,
            durationMs: 9_000,
            endedBy: "closed",
          }),
        ]);
      }),
    ));

  it("ends a stall the viewer gave up on when the player closes", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const scope = yield* Scope.make();
        const playback = playbackAt(base);

        yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        player.userPlay();
        player.stall();
        yield* TestClock.adjust(7_000);
        yield* Scope.close(scope, Exit.void);

        expect(received().map((event) => event.observation)).toMatchObject([
          { _tag: "BufferingStarted" },
          { _tag: "BufferingEnded", durationMs: 7_000, endedBy: "closed" },
        ]);
      }),
    ));

  it("counts a stall as no time when the clock was set back during it", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const scope = yield* Scope.make();
        const playback = playbackAt(base);

        yield* TestClock.setTime(1_760_000_000_000);
        yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        player.userPlay();
        player.stall();
        yield* TestClock.setTime(1_760_000_000_000 - 60_000);
        player.recover();
        yield* Scope.close(scope, Exit.void);

        expect(received().map((event) => event.observation)).toMatchObject([
          { _tag: "BufferingStarted" },
          { _tag: "BufferingEnded", durationMs: 0, endedBy: "playing" },
        ]);
      }),
    ));

  it("reads the player as it is told to close, never after", () =>
    onTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const playback = playbackAt(base);
        const { element, player } = makeElement();
        let released = false;

        const read = <A>(value: A): A => {
          if (released) throw new Error("The player was released");

          return value;
        };

        const recorder = yield* reportDiagnostics(
          { ...player, positionMs: () => read(element.positionMs) },
          {
            platform: "ios",
            playback: () => Option.some(playback),
            bufferedAheadSeconds: () => read(8),
            frames: () => Option.some(read({ dropped: 3, decoded: 100 })),
          },
        ).pipe(Scope.provide(scope));

        element.paused = false;
        element.positionMs = 60_000;
        element.emit("playing");
        element.emit("waiting");
        yield* TestClock.adjust(4_000);
        recorder.close();
        released = true;
        element.emit("playing");
        yield* Scope.close(scope, Exit.void);

        expect(received().map((event) => event.observation)).toStrictEqual([
          PlayerObservation.cases.BufferingStarted.make({
            positionSeconds: 60,
            bufferedAheadSeconds: 8,
          }),
          PlayerObservation.cases.BufferingEnded.make({
            positionSeconds: 60,
            bufferedAheadSeconds: 8,
            durationMs: 4_000,
            endedBy: "closed",
          }),
          PlayerObservation.cases.DroppedFrames.make({ dropped: 3, decoded: 100 }),
        ]);
      }),
    ));

  it("sends to a provided MediaOrigin instead of the session's public URL", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const scope = yield* Scope.make();
        const playback = playbackAt("http://192.0.2.1:9");

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope), Effect.provideService(MediaOrigin, Option.some(base)));

        recorder.record(recovery("origin"));
        yield* Scope.close(scope, Exit.void);

        expect(received().map((event) => event.observation)).toMatchObject([{ reason: "origin" }]);
      }),
    ));

  it("splits a burst into batches the service accepts", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const scope = yield* Scope.make();
        const playback = playbackAt(base);

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        for (let index = 0; index < 150; index += 1) {
          recorder.record(
            PlayerObservation.cases.FragmentLoaded.make({
              segment: index,
              durationMs: 50,
              firstByteMs: 10,
              bytes: 1_000,
            }),
          );
        }

        yield* Scope.close(scope, Exit.void);

        expect(batches.map((batch) => batch.events.length)).toStrictEqual([100, 50]);
      }),
    ));

  it("splits a startup into stages from the latest play intent, the first time each is reached", () =>
    onTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const playback = playbackAt(base);
        const { element, player } = makeElement();

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        recorder.reached("negotiated");
        yield* TestClock.adjust(1_000);
        recorder.intent();
        recorder.reached("negotiated");
        yield* TestClock.adjust(1_000);
        recorder.intent();
        element.paused = false;
        element.emit("waiting");
        yield* TestClock.adjust(200);
        recorder.reached("negotiated");
        yield* TestClock.adjust(300);
        recorder.reached("manifestLoaded");
        yield* TestClock.adjust(100);
        recorder.reached("firstFragmentLoaded");
        recorder.reached("manifestLoaded");
        yield* TestClock.adjust(150);
        recorder.reached("firstFrame");
        element.emit("playing");
        recorder.reached("firstFrame");
        yield* Scope.close(scope, Exit.void);

        expect(received().map((event) => event.observation)).toStrictEqual([
          PlayerObservation.cases.StartupEnded.make({
            positionSeconds: 0,
            durationMs: 750,
            endedBy: "playing",
            stages: {
              negotiatedMs: 200,
              manifestLoadedMs: 500,
              firstFragmentMs: 600,
              firstFrameMs: 750,
            },
          }),
        ]);
      }),
    ));

  it("measures stages from the intent time it is given", () =>
    onTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const playback = playbackAt(base);
        const { element, player } = makeElement();

        yield* TestClock.setTime(10_000);

        const recorder = yield* reportDiagnostics(player, {
          platform: "ios",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        recorder.intent(8_500);
        recorder.reached("negotiated");
        element.paused = false;
        element.emit("waiting");
        yield* TestClock.adjust(400);
        recorder.reached("firstFrame");
        yield* TestClock.adjust(100);
        element.paused = true;
        element.emit("paused");
        yield* Scope.close(scope, Exit.void);

        expect(received().map((event) => event.observation)).toStrictEqual([
          PlayerObservation.cases.StartupEnded.make({
            positionSeconds: 0,
            durationMs: 500,
            endedBy: "paused",
            stages: { negotiatedMs: 1_500, firstFrameMs: 1_900 },
          }),
        ]);
      }),
    ));

  it("holds a startup that played before its first frame until the frame shows", () =>
    onTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const playback = playbackAt(base);
        const { element, player } = makeElement();

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        recorder.intent();
        element.paused = false;
        element.emit("waiting");
        yield* TestClock.adjust(400);
        recorder.reached("negotiated");
        yield* TestClock.adjust(100);
        element.emit("playing");
        yield* TestClock.adjust(30);
        recorder.reached("firstFrame");
        yield* TestClock.adjust(1_000);
        recorder.reached("firstFrame");
        yield* Scope.close(scope, Exit.void);

        expect(received()).toStrictEqual([
          {
            ageMs: 1_030,
            streamId: "AAAAAAAAAAAAAAAAAAAAAA",
            observation: PlayerObservation.cases.StartupEnded.make({
              positionSeconds: 0,
              durationMs: 500,
              endedBy: "playing",
              stages: { negotiatedMs: 400, firstFrameMs: 530 },
            }),
          },
        ]);
      }),
    ));

  it("sends a held startup with the stages it knows when the player closes", () =>
    onTestClock(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const playback = playbackAt(base);
        const { element, player } = makeElement();

        const recorder = yield* reportDiagnostics(player, {
          platform: "ios",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        recorder.intent();
        recorder.reached("negotiated");
        element.paused = false;
        element.emit("waiting");
        yield* TestClock.adjust(500);
        element.emit("playing");
        yield* TestClock.adjust(1_500);
        recorder.close();
        recorder.reached("firstFrame");
        yield* Scope.close(scope, Exit.void);

        expect(received()).toStrictEqual([
          {
            ageMs: 1_500,
            streamId: "AAAAAAAAAAAAAAAAAAAAAA",
            observation: PlayerObservation.cases.StartupEnded.make({
              positionSeconds: 0,
              durationMs: 500,
              endedBy: "playing",
              stages: { negotiatedMs: 0 },
            }),
          },
        ]);
      }),
    ));

  it("sends a held startup with a later batch when no first frame comes", () =>
    onTestClock(
      Effect.gen(function* () {
        const playback = playbackAt(base);
        const { element, player } = makeElement();

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => Option.some(playback),
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        });

        recorder.intent();
        element.paused = false;
        element.emit("waiting");
        yield* TestClock.adjust(300);
        recorder.reached("negotiated");
        yield* TestClock.adjust(700);
        element.emit("playing");
        recorder.record(PlayerObservation.cases.Attached.make({ mode: "remux", engine: "hls.js" }));
        yield* TestClock.adjust(4_000);
        yield* until(() => batches.length > 0);

        expect(received()).toMatchObject([{ observation: { _tag: "Attached" } }]);

        yield* TestClock.adjust(5_000);
        yield* until(() => batches.length > 1);

        expect(batches[1]?.events).toStrictEqual([
          {
            ageMs: 9_000,
            streamId: "AAAAAAAAAAAAAAAAAAAAAA",
            observation: PlayerObservation.cases.StartupEnded.make({
              positionSeconds: 0,
              durationMs: 1_000,
              endedBy: "playing",
              stages: { negotiatedMs: 300 },
            }),
          },
        ]);
      }),
    ));

  it("numbers fragment loads from 0 in each playback session until it first plays", () =>
    onTestClock(
      Effect.gen(function* () {
        const player = yield* makeFakePlayer(0);
        const scope = yield* Scope.make();
        const first = playbackAt(base, "v1.first.session", "session-1");
        const renewed = playbackAt(base, "v1.renewed.session", "session-1");
        const next = playbackAt(base, "v1.next.session", "session-2");
        let playing = Option.some(first);

        const recorder = yield* reportDiagnostics(player, {
          platform: "web",
          playback: () => playing,
          bufferedAheadSeconds: () => 0,
          frames: () => Option.none(),
        }).pipe(Scope.provide(scope));

        const load = (segment: number): void => {
          recorder.record(
            PlayerObservation.cases.FragmentLoaded.make({
              segment,
              durationMs: 50,
              firstByteMs: 10,
              bytes: 1_000,
            }),
          );
        };

        load(4);
        load(5);
        playing = Option.some(renewed);
        load(6);
        player.userPlay();
        load(7);
        playing = Option.some(next);
        load(0);
        load(1);
        yield* Scope.close(scope, Exit.void);

        expect(
          received().flatMap(({ observation }) =>
            Predicate.isTagged(observation, "FragmentLoaded")
              ? [[observation.segment, observation.index]]
              : [],
          ),
        ).toStrictEqual([
          [4, 0],
          [5, 1],
          [6, 2],
          [7, undefined],
          [0, 0],
          [1, 1],
        ]);
      }),
    ));
});

const probeAudio = (index: number, language: string | null): AudioStream => ({
  index,
  codec: "eac3",
  profile: null,
  channels: 6,
  channelLayout: "5.1(side)",
  language,
  title: null,
  default: index === 1,
  bitRate: null,
});

const withAudio = (stream: NegotiateResponse["audio"]): Playback =>
  playbackAt(base, "v1.payload.signature", "session-1", {
    stream,
    tracks: [probeAudio(1, "eng"), probeAudio(2, null), probeAudio(3, "en-Latn-GB-x-private")],
  });

describe("player observations", () => {
  it("names the audio rendition a stream plays when it attaches", () => {
    expect(
      attached(withAudio({ streamIndex: 1, codec: "aac", channels: 2 }), "hls.js"),
    ).toStrictEqual(
      PlayerObservation.cases.Attached.make({
        mode: "remux",
        engine: "hls.js",
        audio: { codec: "aac", channels: 2, language: "eng" },
      }),
    );
    expect(
      attached(withAudio({ streamIndex: 2, codec: "eac3", channels: 6 }), "avplayer"),
    ).toStrictEqual(
      PlayerObservation.cases.Attached.make({
        mode: "remux",
        engine: "avplayer",
        audio: { codec: "eac3", channels: 6 },
      }),
    );
    expect(
      attached(withAudio({ streamIndex: 3, codec: "aac", channels: 2 }), "hls.js"),
    ).toStrictEqual(
      PlayerObservation.cases.Attached.make({
        mode: "remux",
        engine: "hls.js",
        audio: { codec: "aac", channels: 2 },
      }),
    );
    expect(attached(withAudio(undefined), "html-video")).toStrictEqual(
      PlayerObservation.cases.Attached.make({ mode: "remux", engine: "html-video" }),
    );
  });
});
