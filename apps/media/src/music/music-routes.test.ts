import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import type { ResolvedTrack } from "@media/contracts/models/music";
import { MusicStreamTimingHeader, musicStreamPath } from "@media/contracts/music-playback";
import { serverFunctions } from "@media/contracts/server-functions";
import type { SessionStatus } from "@media/contracts/server-functions";
import { artworkTicketId, loadTicketKeyRing } from "@media/contracts/ticket";
import type { TicketPurpose } from "@media/contracts/ticket";
import { TICKET_TEST_KEYS } from "@media/contracts/ticket-vectors";
import { EpochMillis } from "@media/contracts/units";
import { Duration, Effect, Exit, Layer, Option, Redacted, Scope, SubscriptionRef } from "effect";
import { HttpServer } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as CoreTickets from "../core/core-tickets.ts";
import { serve } from "../http/http-server.ts";
import * as MediaTools from "../media/media-tools.ts";
import * as StreamOwners from "../playback/stream-owners.ts";
import { makeFakeCore, stream } from "../testing/fake-core.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import { saveArt } from "./art-store.ts";
import * as MusicRoutes from "./music-routes.ts";
import {
  makeDirectory,
  PNG,
  removeDirectory,
  resizeFile,
  writeBytes,
  writeSong,
} from "./testing/music-fixtures.ts";
import { ffprobe } from "./testing/music-songs.ts";
import * as TrackSources from "./track-sources.ts";
import * as MusicTranscoder from "./transcoder.ts";

const HOUR = 60 * 60 * 1000;

const principal = { userId: "user1", sessionId: "session1" };

const SONG = "songtrack1";

const OTHER = "songtrack2";

const LARGE = "largetrack";

const TONE = "longtonetrack";

/** The long tone's length: encoding it (about 11x real time) outlasts a transcode's 1 s grace. */
const TONE_SECONDS = 60;

let work = "";

let library = "";

let baseUrl = "";

let scope: Scope.Closeable;

let status: SubscriptionRef.SubscriptionRef<SessionStatus>;

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const ring = async () => {
  const loaded = await loadTicketKeyRing(TICKET_TEST_KEYS.k1);

  if (!loaded.ok) throw new Error("The test keys are unusable");

  return loaded.value;
};

const issue = async (trackId: string, purpose: TicketPurpose = "play", lifetimeMs = HOUR) => {
  const issued = await (
    await ring()
  ).issuePersonal({
    principal,
    playback: crypto.randomUUID(),
    resource: { kind: "track", id: trackId },
    purpose,
    now: Date.now(),
    lifetimeMs,
  });

  if (!issued.ok) throw new Error("The test ticket was not issued");

  return issued.value.ticket;
};

/** A shareable ticket for the artwork with hash `hash`, as the music commands sign it. */
const artTicket = async (hash: string) =>
  (
    await (
      await ring()
    ).issueShareable({
      resource: { kind: "artwork", id: await artworkTicketId(hash) },
      now: Date.now(),
    })
  ).ticket;

const streamUrl = (trackId: string, ticket: string, query = "") =>
  `${baseUrl}${musicStreamPath(trackId)}?ticket=${encodeURIComponent(ticket)}${query}`;

/** Reads a body to its end: how many bytes came, and whether the server cut it off. */
const drain = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  bytes: number,
): Promise<{ readonly bytes: number; readonly aborted: boolean }> => {
  const next = await reader.read().catch(() => null);

  if (next === null) return { bytes, aborted: true };

  return next.done ? { bytes, aborted: false } : drain(reader, bytes + next.value.byteLength);
};

const sources = (tracks: ReadonlyMap<string, ResolvedTrack>) =>
  Layer.succeed(
    TrackSources.Service,
    TrackSources.Service.of({
      resolve: (trackId) => Effect.succeed(Option.fromUndefinedOr(tracks.get(trackId))),
      forget: () => Effect.void,
    }),
  );

const resolved = (trackId: string, path: string, codec: string): ResolvedTrack => ({
  trackId,
  libraryId: "library1",
  path,
  roots: [library],
  size: 1,
  mtimeMs: 1,
  codec,
});

beforeAll(async () => {
  work = await makeDirectory("routes");
  library = join(work, "library");

  await writeSong(join(library, "Album", "01 Song.flac"), { seconds: 3 });
  await writeSong(join(library, "Album", "02 Other.flac"), { seconds: 1 });
  await writeSong(join(library, "Album", "03 Large.wav"), { seconds: 1 });
  await writeSong(join(library, "Album", "04 Long Tone.flac"), { seconds: TONE_SECONDS });
  // Far larger than socket buffers, so its response is still open when its session ends.
  await resizeFile(join(library, "Album", "03 Large.wav"), 128 * 1024 * 1024);

  scope = await run(Scope.make());

  const now = Date.now();

  status = await run(
    SubscriptionRef.make<SessionStatus>({
      state: "live",
      endsAt: EpochMillis.make(now + HOUR),
      guest: false,
    }),
  );

  const fake = await run(
    makeFakeCore([stream(serverFunctions.sessionStatus, () => SubscriptionRef.changes(status))]),
  );

  const config = testConfigLayer({ DATA_DIR: join(work, "data"), LIBRARY_ROOTS: library });

  const tracks = new Map([
    [SONG, resolved(SONG, join(library, "Album", "01 Song.flac"), "flac")],
    [OTHER, resolved(OTHER, join(library, "Album", "02 Other.flac"), "flac")],
    [LARGE, resolved(LARGE, join(library, "Album", "03 Large.wav"), "pcm")],
    [TONE, resolved(TONE, join(library, "Album", "04 Long Tone.flac"), "flac")],
  ]);

  const http = serve(MusicRoutes.layer).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    Layer.provide(
      CoreTickets.layer({
        ticketKeys: Redacted.make(TICKET_TEST_KEYS.k1),
        idle: Duration.seconds(30),
      }).pipe(Layer.provide(fake.layer), Layer.provide(StreamOwners.layer)),
    ),
    Layer.provide(sources(tracks)),
    Layer.provide(MusicTranscoder.layer.pipe(Layer.provide(MediaTools.layer))),
    Layer.provide(config),
    Layer.provide(NodeServices.layer),
  );

  const built = await run(Layer.buildWithScope(http, scope));

  baseUrl = await run(
    HttpServer.addressFormattedWith((url) => Effect.succeed(url)).pipe(
      Effect.provideContext(built),
    ),
  );
}, 60_000);

afterAll(async () => {
  await run(Scope.close(scope, Exit.void));
  await removeDirectory(work);
});

describe("music routes", { timeout: 60_000 }, () => {
  it("serve a song's original to its ticket, with ranges, and refuse other tickets", async () => {
    const ticket = await issue(SONG);
    const whole = await fetch(streamUrl(SONG, ticket));
    const bytes = new Uint8Array(await whole.arrayBuffer());

    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/flac");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");

    const etag = whole.headers.get("etag") ?? "";

    const part = await fetch(streamUrl(SONG, ticket), {
      headers: { range: "bytes=10-19", "if-range": etag },
    });

    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 10-19/${String(bytes.length)}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(10, 20));
    expect(
      (await fetch(streamUrl(SONG, ticket), { headers: { "if-none-match": etag } })).status,
    ).toBe(304);

    expect((await fetch(`${baseUrl}${musicStreamPath(SONG)}`)).status).toBe(401);
    expect((await fetch(streamUrl(OTHER, ticket))).status).toBe(403);
    expect((await fetch(streamUrl(SONG, "t1.not-a-ticket"))).status).toBe(401);
    expect((await fetch(streamUrl(SONG, ticket, "&p=mp3"))).status).toBe(400);
    expect((await fetch(streamUrl(SONG, ticket, "&start=500"))).status).toBe(400);
    expect((await fetch(streamUrl("missingtrack", await issue("missingtrack")))).status).toBe(404);
    expect((await fetch(streamUrl(SONG, await issue(SONG, "download")))).status).toBe(200);
  });

  it("serve gapless transcodes with their timing, offsets on the song's timeline, and finished files", async () => {
    const ticket = await issue(SONG);
    const head = await fetch(streamUrl(SONG, ticket, "&p=fmp4-aac"), { method: "HEAD" });

    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("audio/mp4");
    expect(head.headers.get(MusicStreamTimingHeader.priming)).toBe("1024");
    expect(head.headers.get(MusicStreamTimingHeader.duration)).toBe(String(3 * 44_100));
    expect(head.headers.get(MusicStreamTimingHeader.sampleRate)).toBe("44100");

    const offset = await fetch(streamUrl(SONG, ticket, "&p=aac-128&start=500"));

    expect(offset.status).toBe(200);
    expect(offset.headers.get("content-type")).toBe("audio/aac");
    expect(offset.headers.get(MusicStreamTimingHeader.start)).toBe(String(22_050));
    expect((await offset.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const prepared = async (attempts: number): Promise<Response> => {
      const response = await fetch(streamUrl(OTHER, otherTicket, "&p=fmp4-flac&finished=1"));

      if (response.status !== 503 || attempts === 0) return response;

      expect(response.headers.get("retry-after")).toBe("2");
      await new Promise((resolve) => setTimeout(resolve, 200));

      return prepared(attempts - 1);
    };

    const otherTicket = await issue(OTHER);
    const finished = await prepared(100);

    expect(finished.status).toBe(200);
    expect(finished.headers.get("etag")).not.toBeNull();
    expect(finished.headers.get(MusicStreamTimingHeader.duration)).toBe("44100");
  });

  it("stream each live transcode whole, one after another", async () => {
    const first = await fetch(streamUrl(OTHER, await issue(OTHER), "&p=aac-320"));

    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("audio/aac");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect((await first.arrayBuffer()).byteLength).toBeGreaterThan(0);

    // The second live transcode must not be cut off once the first response has ended.
    const second = await fetch(streamUrl(TONE, await issue(TONE), "&p=aac-320"));
    const body = join(work, "tone.aac");

    expect(second.headers.get("content-type")).toBe("audio/aac");
    await writeBytes(body, new Uint8Array(await second.arrayBuffer()));

    const packets = Number(
      (
        await ffprobe([
          "-v",
          "error",
          "-count_packets",
          "-show_entries",
          "stream=nb_read_packets",
          "-of",
          "csv=p=0",
          body,
        ])
      ).trim(),
    );

    expect((packets * 1024) / 44_100).toBeGreaterThan(TONE_SECONDS - 1);
  });

  it("keep reading an original past its ticket's expiry, but start no transcode with it", async () => {
    const ticket = await issue(OTHER, "play", 1000);

    expect((await fetch(streamUrl(OTHER, ticket))).status).toBe(200);

    // Tickets hold whole seconds, so this one has expired 2 s later.
    await new Promise((resolve) => setTimeout(resolve, 2100));

    expect((await fetch(streamUrl(OTHER, ticket))).status).toBe(200);
    expect((await fetch(streamUrl(OTHER, ticket, "&p=aac-128&finished=1"))).status).toBe(401);
    expect((await fetch(streamUrl(OTHER, ticket, "&p=aac-128&start=200"))).status).toBe(401);
  });

  it("serve art to its shareable ticket only", async () => {
    const hash = await run(saveArt(join(work, "data"), PNG).pipe(Effect.map(Option.getOrThrow)));

    const served = await fetch(`${baseUrl}/music/art/${hash}?ticket=${await artTicket(hash)}`);

    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(
      createHash("sha256")
        .update(new Uint8Array(await served.arrayBuffer()))
        .digest("hex"),
    ).toBe(hash);

    const other = "0".repeat(64);

    expect(
      (await fetch(`${baseUrl}/music/art/${hash}?ticket=${await artTicket(other)}`)).status,
    ).toBe(401);
    expect((await fetch(`${baseUrl}/music/art/${hash}`)).status).toBe(401);
    expect(
      (await fetch(`${baseUrl}/music/art/not-a-hash?ticket=${await artTicket(hash)}`)).status,
    ).toBe(404);
  });

  it("stop an open song once its session ends, and refuse the session's tickets after", async () => {
    const ticket = await issue(LARGE);
    const response = await fetch(streamUrl(LARGE, ticket));

    expect(response.status).toBe(200);

    if (response.body === null) throw new Error("No body");

    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const first = await reader.read();

    expect(first.done).toBe(false);

    await run(SubscriptionRef.set(status, { state: "ended" }));

    const received = await drain(reader, first.value?.byteLength ?? 0);

    expect(received.aborted).toBe(true);
    expect(received.bytes).toBeLessThan(128 * 1024 * 1024);
    expect((await fetch(streamUrl(SONG, await issue(SONG)))).status).toBe(410);
  });
});
