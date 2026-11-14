import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { StreamAccessDenied } from "@media/contracts/media-playback";
import type { ClientCapabilities } from "@media/contracts/media-playback";
import { serverFunctions } from "@media/contracts/server-functions";
import type { SessionStatus } from "@media/contracts/server-functions";
import { loadTicketKeyRing } from "@media/contracts/ticket";
import { TICKET_TEST_KEYS } from "@media/contracts/ticket-vectors";
import { EpochMillis } from "@media/contracts/units";
import { assert, layer } from "@effect/vitest";
import { Context, Duration, Effect, FileSystem, Layer, Redacted, SubscriptionRef } from "effect";
import { HttpServer } from "effect/http";

import { serve } from "../http/http-server.ts";
import * as MediaRoutes from "../http/media-routes.ts";
import { resolveInsideRoots } from "../playback/file-resolver.ts";
import { decidePlayback, PlaybackPlan } from "../playback/playback-decision.ts";
import * as PlaybackToken from "../playback/playback-grants.ts";
import * as StreamOwners from "../playback/stream-owners.ts";
import * as StreamSessions from "../playback/stream-sessions.ts";
import { makeFakeCore, stream } from "../testing/fake-core.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import * as CoreTickets from "./core-tickets.ts";

const HOUR = 60 * 60 * 1000;

/** Reads a body to its end: how many bytes came, and whether the server cut it off. */
const drain = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  bytes: number,
): Promise<{ readonly bytes: number; readonly aborted: boolean }> => {
  const next = await reader.read().catch(() => null);

  if (next === null) return { bytes, aborted: true };

  return next.done ? { bytes, aborted: false } : drain(reader, bytes + next.value.byteLength);
};

const principal = { userId: "user1", sessionId: "session1" };

const client: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 120,
  hls: true,
  mse: true,
};

const issue = (fileId: string, now: number, playback?: string, kind: "file" | "track" = "file") =>
  Effect.promise(async () => {
    const loaded = await loadTicketKeyRing(TICKET_TEST_KEYS.k1);

    if (!loaded.ok) throw new Error("The test keys are unusable");

    const issued = await loaded.value.issuePersonal({
      principal,
      playback,
      resource: { kind, id: fileId },
      purpose: "play",
      now,
      lifetimeMs: HOUR,
    });

    if (!issued.ok) throw new Error("The test ticket was not issued");

    return issued.value.ticket;
  });

/** Core tickets over a fake core whose session the test ends, beside the test server's streams. */
const coreTickets = (now: number) =>
  Effect.gen(function* () {
    const status = yield* SubscriptionRef.make<SessionStatus>({
      state: "live",
      endsAt: EpochMillis.make(now + HOUR),
      guest: false,
    });

    const fake = yield* makeFakeCore([
      stream(serverFunctions.sessionStatus, () => SubscriptionRef.changes(status)),
    ]);

    const owners = yield* StreamOwners.Service;

    const context = yield* Layer.build(
      CoreTickets.layer({
        ticketKeys: Redacted.make(TICKET_TEST_KEYS.k1),
        idle: Duration.seconds(30),
      }).pipe(
        Layer.provide(fake.layer),
        Layer.provide(Layer.succeed(StreamOwners.Service, owners)),
      ),
    );

    return { status, tokens: Context.get(context, PlaybackToken.Service) };
  });

layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "120 seconds" })(
  "CoreTickets with real streams",
  (it) => {
    it.effect(
      "keeps two starts in one second apart: each its own stream, neither stops the other",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const sessions = yield* StreamSessions.Service;
          const fileId = server.fileId("movies", library.directMovie);
          const now = Date.now();
          const { tokens } = yield* coreTickets(now);

          // movies.play.start names each start's playback in its ticket; both in the same second.
          const first = yield* issue(fileId, now, "6f1d7c2a-1b3e-4c5d-9e8f-0a1b2c3d4e5f");
          const second = yield* issue(fileId, now, "0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b");

          assert.notStrictEqual(first, second);

          const a = yield* tokens.verify(Redacted.make(first), PlaybackToken.PLAY);
          const b = yield* tokens.verify(Redacted.make(second), PlaybackToken.PLAY);

          assert.notStrictEqual(a.sessionId, b.sessionId);

          const file = yield* resolveInsideRoots(a.fileId, { sidecars: false });

          const plan = decidePlayback(file.probe, client, {
            audioIndex: undefined,
            hardware: undefined,
            softwareToneMapping: false,
          });

          if (!PlaybackPlan.$is("Hls")(plan)) throw new Error("The fixture should play as HLS");

          const start = (grant: PlaybackToken.PlaybackGrant) =>
            sessions.negotiate(grant).pipe(
              Effect.flatMap((negotiation) =>
                negotiation.start({
                  file,
                  plan,
                  client,
                  audioIndex: undefined,
                  startSeconds: 0,
                  quality: undefined,
                  burnSubtitle: undefined,
                  keyframes: undefined,
                }),
              ),
              Effect.scoped,
            );

          const streamA = yield* start(a);
          const streamB = yield* start(b);

          assert.strictEqual(yield* sessions.activeCount, 2);
          yield* sessions.playlist(streamA.streamId, streamA.generation, a);
          yield* sessions.playlist(streamB.streamId, streamB.generation, b);

          const crossStop = yield* Effect.flip(sessions.stop(streamB.streamId, a));

          assert.instanceOf(crossStop, StreamAccessDenied);
          assert.strictEqual(yield* sessions.activeCount, 2);

          yield* sessions.stop(streamA.streamId, a);
          yield* sessions.stop(streamB.streamId, b);
        }).pipe(Effect.scoped),
      60_000,
    );

    it.effect(
      "refuses a track's ticket for a file, and stops an open direct-play response once its session ends",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fileId = server.fileId("movies", library.directMovie);
          const file = yield* resolveInsideRoots(fileId, { sidecars: false });
          const size = 128 * 1024 * 1024;

          // A file far larger than socket buffers, so the response is still open when it ends.
          yield* (yield* FileSystem.FileSystem).truncate(file.path, size);

          const now = Date.now();
          const { tokens, status } = yield* coreTickets(now);
          const ticket = yield* issue(fileId, now, "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d");

          const address = Layer.effectContext(
            HttpServer.addressFormattedWith((baseUrl) =>
              Effect.succeed(Context.make(MediaTestServer.Service, { ...server, baseUrl })),
            ),
          );

          const http = serve(MediaRoutes.layer).pipe(
            Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
          );

          const routes = yield* Layer.build(address.pipe(Layer.provide(http))).pipe(
            Effect.provideService(PlaybackToken.Service, tokens),
          );

          const { baseUrl } = Context.get(routes, MediaTestServer.Service);

          // A music track's ticket naming the same id is not a ticket for this file.
          const track = yield* issue(fileId, now, "7b6a5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d", "track");

          const refused = yield* Effect.promise(() =>
            fetch(`${baseUrl}/media/direct/${fileId}?ticket=${encodeURIComponent(track)}`),
          );

          assert.strictEqual(refused.status, 403);

          const response = yield* Effect.promise(() =>
            fetch(`${baseUrl}/media/direct/${fileId}?ticket=${encodeURIComponent(ticket)}`),
          );

          assert.strictEqual(response.status, 200);

          if (response.body === null) throw new Error("No body");

          const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();

          const first = yield* Effect.promise(() => reader.read());

          assert.isFalse(first.done);

          yield* SubscriptionRef.set(status, { state: "ended" });

          const received = yield* Effect.promise(() => drain(reader, first.value.byteLength)).pipe(
            Effect.timeout("10 seconds"),
          );

          assert.isTrue(received.aborted);
          assert.isBelow(received.bytes, size);
        }).pipe(Effect.scoped),
      60_000,
    );
  },
);
