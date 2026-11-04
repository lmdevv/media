import { join } from "node:path";

import { LogRecord } from "@media/contracts/diagnostics";
import { DeviceId } from "@media/contracts/ids";
import type { LibraryId, PlaybackSessionId, ProfileId, TitleId } from "@media/contracts/ids";
import {
  type ClientCapabilities,
  HealthResponse,
  MEDIA_ROUTES,
  NegotiateRequest,
  NegotiateResponse,
} from "@media/contracts/media-playback";
import type { StartedPlayback } from "@media/contracts/models/playback";
import { Milliseconds } from "@media/contracts/units";
import type { ConvexTransport, Movies } from "@media/sdk/effect";
import { Effect, Exit, Option, Redacted, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encodeTestMovie, ffmpegAvailable } from "../testing/fixture-library.ts";
import type { MediaProcess } from "../testing/stack-processes.ts";
import {
  client,
  finished,
  openSession,
  runIn,
  signInOwner,
  type StackSession,
} from "../testing/stack-owner.ts";
import {
  buildServiceAndCli,
  findMediaStack,
  makeTempDir,
  removeDir,
  startMedia,
  waitForBody,
} from "../testing/stack-processes.ts";

const stack = findMediaStack();

const hasFfmpeg = await ffmpegAvailable();

const id = Math.random().toString(36).slice(2, 8);

const MOVIE = "Liveness Fixture";

const STREAM_IDLE_SECONDS = 2;

const smallScreen: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 160,
  maxHeight: 90,
  hls: false,
  mse: true,
};

let scope: Scope.Closeable;

let owner: StackSession;

let media: MediaProcess;

let workspace = "";

let profileId: ProfileId;

let libraryId: LibraryId | undefined;

let titleId: TitleId;

const decodeHealth = Schema.decodeUnknownOption(Schema.fromJsonString(HealthResponse));

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(LogRecord));

const encodeNegotiate = Schema.encodeSync(Schema.toCodecJson(NegotiateRequest));

const decodeNegotiated = Schema.decodeUnknownSync(Schema.toCodecJson(NegotiateResponse));

const asOwner = <A, E>(
  effect: Effect.Effect<A, E, Movies.Services | ConvexTransport.ConvexTransport>,
): Promise<A> => runIn(owner, effect);

const loggedAbout = (message: string, streamId: string): ReadonlyArray<LogRecord> =>
  media
    .logs()
    .split("\n")
    .flatMap((line) => Option.toArray(decodeRecord(line)))
    .filter((record) => record.message === message && record.annotations["streamId"] === streamId);

const awaitLogged = async (
  message: string,
  streamId: string,
  timeoutMs: number,
): Promise<ReadonlyArray<LogRecord>> => {
  const deadline = Date.now() + timeoutMs;

  const attempt = async (): Promise<ReadonlyArray<LogRecord>> => {
    const records = loggedAbout(message, streamId);

    if (records.length > 0 || Date.now() > deadline) return records;
    await new Promise((resolve) => setTimeout(resolve, 200));

    return attempt();
  };

  return attempt();
};

const report = (
  sessionId: PlaybackSessionId,
  positionMs: number,
  event: "tick" | "pause" | "resume",
) =>
  Effect.flatMap(client, (movies) =>
    movies.mutate("playback.reportProgress", {
      sessionId,
      positionMs: Milliseconds.make(positionMs),
      event,
    }),
  );

const play = (sessionId: PlaybackSessionId, seconds: number) =>
  asOwner(
    report(sessionId, 0, "resume").pipe(
      Effect.andThen(
        Effect.forEach(
          Array.from({ length: seconds }, (_, index) => (index + 1) * 1000),
          (positionMs) =>
            Effect.sleep("1 second").pipe(Effect.andThen(report(sessionId, positionMs, "tick"))),
          { discard: true },
        ),
      ),
    ),
  );

const negotiate = async (started: StartedPlayback) => {
  const response = await fetch(`${started.mediaBaseUrl}${MEDIA_ROUTES.negotiate}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      encodeNegotiate({
        token: Redacted.make(started.token),
        capabilities: smallScreen,
        startSeconds: 0,
      }),
    ),
  });

  const body: unknown = await response.json();

  expect(response.status, JSON.stringify(body)).toBe(200);

  const stream = decodeNegotiated(body);
  const playlist = await (await fetch(stream.url)).text();
  const base = stream.url.slice(0, stream.url.lastIndexOf("/") + 1);

  return {
    mode: stream.mode,
    streamId: stream.streamId ?? "",
    init: `${base}${/URI="([^"]+)"/u.exec(playlist)?.[1] ?? ""}`,
    segments: playlist
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => `${base}${line}`),
  };
};

const status = async (url: string | undefined): Promise<number> =>
  url === undefined ? 0 : (await fetch(url)).status;

describe.skipIf(stack === undefined || !hasFfmpeg)(
  "stream liveness against a real stack",
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      buildServiceAndCli();
      workspace = await makeTempDir("movies-liveness-stack-");

      const moviesRoot = join(workspace, "movies");

      await encodeTestMovie(join(moviesRoot, `${MOVIE} (2020)`, `${MOVIE} (2020).mkv`), 60);

      scope = Scope.makeUnsafe();
      owner = await Effect.runPromise(
        openSession(stack?.convexUrl ?? "", stack?.mediaUrl ?? "", scope),
      );
      await asOwner(signInOwner);

      const profile = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.mutate("profiles.create", { name: `Liveness ${id}`, avatar: "red", kids: false }),
        ),
      );

      profileId = profile.id;

      media = startMedia({
        ...stack?.mediaEnv,
        LIBRARY_ROOTS: workspace,
        HARDWARE_ACCELERATION: "none",
        STREAM_IDLE_SECONDS: String(STREAM_IDLE_SECONDS),
        LIBRARY_RECONCILE_MINUTES: "600",
        MIN_FREE_TRANSCODE_MB: "1",
      });

      await waitForBody(
        `${stack?.mediaUrl ?? ""}${MEDIA_ROUTES.health}`,
        (text) =>
          decodeHealth(text).pipe(
            Option.filter((health) => health.backend === "connected"),
            Option.getOrUndefined,
          ),
        30_000,
      );

      const created = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.mutate("libraries.create", {
            name: `Liveness ${id}`,
            kind: "movies",
            roots: [moviesRoot],
          }),
        ),
      );

      libraryId = created.libraryId;

      const job = await asOwner(finished(created.jobId, "60 seconds"));

      expect(job.status, job.error ?? "").toBe("succeeded");

      const title = await asOwner(
        Effect.gen(function* () {
          const movies = yield* client;

          const found = yield* movies.query("titles.search", {
            profileId,
            query: MOVIE,
            limit: 50,
          });

          const details = yield* Effect.forEach(found, (card) =>
            movies.query("titles.get", { profileId, titleId: card.id }),
          );

          return details.find(
            (detail) => detail.libraryId === created.libraryId && detail.name === MOVIE,
          );
        }),
      );

      if (title === undefined) throw new Error(`${MOVIE} was not scanned`);
      titleId = title.id;
    }, 180_000);

    afterAll(async () => {
      if (libraryId !== undefined) {
        const removed = libraryId;

        await asOwner(
          Effect.flatMap(client, (movies) =>
            movies.mutate("libraries.remove", { libraryId: removed }),
          ),
        ).catch(() => undefined);
      }

      await media.stop("SIGTERM");
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await removeDir(workspace);
    }, 60_000);

    it("keeps a playing stream's encoder through quiet requests, releases it once paused, and resumes it", async () => {
      const started = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.mutate("playback.createSession", {
            profileId,
            deviceId: DeviceId.make(`liveness-stack-${id}`),
            titleId,
          }),
        ),
      );

      const stream = await negotiate(started);

      expect(stream.mode).toBe("transcode-software");
      expect(
        await Promise.all([stream.init, ...stream.segments.slice(0, 3)].map(status)),
      ).toStrictEqual([200, 200, 200, 200]);

      await play(started.sessionId, 2 * STREAM_IDLE_SECONDS + 1);

      expect(
        loggedAbout("Stream.released", stream.streamId),
        "no release while playing",
      ).toStrictEqual([]);
      expect(await status(stream.segments[3]), "the next segment after a quiet stretch").toBe(200);

      await asOwner(report(started.sessionId, 6000, "pause"));

      const released = await awaitLogged("Stream.released", stream.streamId, 15_000);

      expect(released.map((record) => record.annotations["liveness"])).toStrictEqual(["paused"]);
      expect(await status(stream.segments[4]), "the first segment after the pause").toBe(200);
      expect(loggedAbout("Stream.resumed", stream.streamId)).toHaveLength(1);

      await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.mutate("playback.endSession", {
            sessionId: started.sessionId,
            positionMs: Milliseconds.make(8000),
          }),
        ),
      );
    });
  },
);
