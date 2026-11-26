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
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Scope,
  SubscriptionRef,
} from "effect";
import { FetchHttpClient, HttpServer } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as ArtworkStore from "../artwork/artwork-store.ts";
import * as CachePruner from "../cache-pruner.ts";
import * as CoreTickets from "../core/core-tickets.ts";
import { serve } from "../http/http-server.ts";
import * as MediaTools from "../media/media-tools.ts";
import * as PlaybackToken from "../playback/playback-grants.ts";
import * as StreamOwners from "../playback/stream-owners.ts";
import { makeFakeCore, stream } from "../testing/fake-core.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import { testArtworkKeysLayer } from "../testing/test-tokens.ts";
import { saveArt } from "./art-store.ts";
import * as Files from "./music-files.ts";
import * as MusicRoutes from "./music-routes.ts";
import {
  makeDirectory,
  PNG,
  removeDirectory,
  resizeFile,
  writeBytes,
  writeSong,
} from "./testing/music-fixtures.ts";
import { ffmpeg, ffprobe } from "./testing/music-songs.ts";
import * as TrackSources from "./track-sources.ts";
import * as MusicTranscoder from "./transcoder.ts";

const HOUR = 60 * 60 * 1000;

const principal = { userId: "user1", sessionId: "session1" };

const SONG = "songtrack1";

const OTHER = "songtrack2";

const LARGE = "largetrack";

const TONE = "longtonetrack";

const BROKEN = "brokentrack";

/** The long tone's length: encoding it (about 11x real time) outlasts a transcode's 1 s grace. */
const TONE_SECONDS = 60;

let work = "";

let library = "";

let baseUrl = "";

let scope: Scope.Closeable;

let status: SubscriptionRef.SubscriptionRef<SessionStatus>;

let tokens: PlaybackToken.Interface;

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

/**
 * Asks `url` with `method` until the server has the finished transcode, as players and
 * downloaders do: a `503` with `Retry-After` means ask again.
 */
const whenFinished = async (
  url: string,
  method: "GET" | "HEAD",
  attempts = 100,
): Promise<Response> => {
  const response = await fetch(url, { method });

  if (response.status !== 503 || attempts === 0) return response;

  expect(response.headers.get("retry-after")).toBe("2");
  expect(response.headers.get("cache-control")).toBe("no-store");
  await response.arrayBuffer();
  await new Promise((resolve) => setTimeout(resolve, 200));

  return whenFinished(url, method, attempts - 1);
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

/** `width,height` of the copy the art route serves at `?w=width` of a cover `size` pixels big. */
const servedArtSize = async (size: string, width: string) => {
  const original = join(work, `cover-${size}.jpg`);

  await ffmpeg(["-f", "lavfi", "-i", `testsrc=size=${size}`, "-frames:v", "1", original]);

  const hash = await run(
    saveArt(join(work, "data"), await run(Files.readWholeFile(original))).pipe(
      Effect.map(Option.getOrThrow),
    ),
  );

  const response = await fetch(
    `${baseUrl}/music/art/${hash}?ticket=${await artTicket(hash)}&w=${width}`,
  );

  const copy = join(work, `copy-${size}-${width}.jpg`);

  await writeBytes(copy, new Uint8Array(await response.arrayBuffer()));

  const probed = await ffprobe([
    "-v",
    "error",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    copy,
  ]);

  return probed.trim();
};

beforeAll(async () => {
  work = await makeDirectory("routes");
  library = join(work, "library");

  await writeSong(join(library, "Album", "01 Song.flac"), { seconds: 3 });
  await writeSong(join(library, "Album", "02 Other.flac"), { seconds: 1 });
  await writeSong(join(library, "Album", "03 Large.wav"), { seconds: 1 });
  await writeSong(join(library, "Album", "04 Long Tone.flac"), { seconds: TONE_SECONDS });
  // An MP3 by its name, a browser plays it, but ffmpeg cannot read it.
  await writeBytes(join(library, "Album", "05 Broken.mp3"), "not audio at all");
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
    [BROKEN, resolved(BROKEN, join(library, "Album", "05 Broken.mp3"), "mp3")],
  ]);

  const http = serve(MusicRoutes.layer).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    Layer.provideMerge(
      CoreTickets.layer({
        ticketKeys: Redacted.make(TICKET_TEST_KEYS.k1),
        idle: Duration.seconds(30),
      }).pipe(Layer.provide(fake.layer), Layer.provide(StreamOwners.layer)),
    ),
    Layer.provide(sources(tracks)),
    Layer.provide(
      ArtworkStore.layer.pipe(
        Layer.provide([testArtworkKeysLayer, MediaTools.layer, FetchHttpClient.layer]),
      ),
    ),
    Layer.provide(MusicTranscoder.layer.pipe(Layer.provide([MediaTools.layer, CachePruner.layer]))),
    Layer.provide(config),
    Layer.provide(NodeServices.layer),
  );

  const built = await run(Layer.buildWithScope(http, scope));

  tokens = Context.get(built, PlaybackToken.Service);

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
    const head = await whenFinished(streamUrl(SONG, ticket, "&p=fmp4-aac"), "HEAD");

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

    const otherTicket = await issue(OTHER);

    const finished = await whenFinished(
      streamUrl(OTHER, otherTicket, "&p=fmp4-flac&finished=1"),
      "GET",
    );

    expect(finished.status).toBe(200);
    expect(finished.headers.get("etag")).not.toBeNull();
    expect(finished.headers.get(MusicStreamTimingHeader.duration)).toBe("44100");
  });

  it("answer a HEAD of a song still transcoding at once, then with its exact timing", async () => {
    const ticket = await issue(TONE);
    const live = await fetch(streamUrl(TONE, ticket, "&p=fmp4-aac"));

    expect(live.headers.get(MusicStreamTimingHeader.estimated)).toBe("1");

    if (live.body === null) throw new Error("No body");

    const reader: ReadableStreamDefaultReader<Uint8Array> = live.body.getReader();

    expect((await reader.read()).done).toBe(false);

    const early = await fetch(streamUrl(TONE, ticket, "&p=fmp4-aac"), { method: "HEAD" });

    expect(early.status).toBe(503);
    expect(early.headers.get("retry-after")).toBe("2");
    expect(early.headers.get("cache-control")).toBe("no-store");
    expect((await drain(reader, 0)).aborted).toBe(false);

    const finished = await whenFinished(streamUrl(TONE, ticket, "&p=fmp4-aac"), "HEAD");

    expect(finished.status).toBe(200);
    expect(finished.headers.get(MusicStreamTimingHeader.estimated)).toBeNull();
    expect(finished.headers.get(MusicStreamTimingHeader.duration)).toBe(
      String(TONE_SECONDS * 44_100),
    );
    expect(finished.headers.get("etag")).not.toBeNull();
  });

  it("answer a HEAD as its GET does when a song the browser plays cannot be transcoded", async () => {
    const ticket = await issue(BROKEN);
    const head = await whenFinished(streamUrl(BROKEN, ticket, "&p=aac-128"), "HEAD");

    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("audio/mpeg");

    const get = await fetch(streamUrl(BROKEN, ticket, "&p=aac-128"));

    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("audio/mpeg");
    await get.arrayBuffer();
    expect((await fetch(streamUrl(BROKEN, ticket, "&p=aac-128&finished=1"))).status).toBe(502);
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

  it("serve nothing to an expired ticket, but run a response under way to its end", async () => {
    const ticket = await issue(LARGE, "play", 2000);
    const response = await fetch(streamUrl(LARGE, ticket));

    expect(response.status).toBe(200);

    if (response.body === null) throw new Error("No body");

    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const first = await reader.read();

    expect(first.done).toBe(false);

    // A seek while the ticket lasts.
    const seek = await fetch(streamUrl(LARGE, ticket), { headers: { range: "bytes=4096-8191" } });

    expect(seek.status).toBe(206);
    expect((await seek.arrayBuffer()).byteLength).toBe(4096);

    // Tickets hold whole seconds, so this one has expired 3 s later.
    await new Promise((resolve) => setTimeout(resolve, 3100));

    expect(await drain(reader, first.value?.byteLength ?? 0)).toEqual({
      bytes: 128 * 1024 * 1024,
      aborted: false,
    });

    const answers = await Promise.all(
      ["", "&p=aac-128", "&p=aac-128&finished=1", "&p=aac-128&start=200"].map(async (query) => {
        const refused = await fetch(streamUrl(LARGE, ticket, query), {
          headers: { range: "bytes=0-1023" },
        });

        return [refused.status, await refused.text()] as const;
      }),
    );

    expect(answers).toEqual(Array.from({ length: 4 }, () => [401, "Invalid or expired ticket"]));
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

  it("serve art resized to an allowed width, with ranges, and refuse other widths", async () => {
    const original = join(work, "cover.jpg");

    await ffmpeg(["-f", "lavfi", "-i", "testsrc=size=600x600", "-frames:v", "1", original]);
    const bytes = await run(Files.readWholeFile(original));
    const hash = await run(saveArt(join(work, "data"), bytes).pipe(Effect.map(Option.getOrThrow)));
    const ticket = await artTicket(hash);

    const sized = (width: string, query = `ticket=${ticket}`) =>
      `${baseUrl}/music/art/${hash}?${query}&w=${width}`;

    const widthOf = async (response: Response, name: string) => {
      const file = join(work, name);

      await writeBytes(file, new Uint8Array(await response.arrayBuffer()));

      return ffprobe(["-v", "error", "-show_entries", "stream=width", "-of", "csv=p=0", file]);
    };

    const small = await fetch(sized("185"));

    expect(small.status).toBe(200);
    expect(small.headers.get("content-type")).toBe("image/jpeg");
    expect(small.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const length = Number(small.headers.get("content-length"));

    expect(length).toBeLessThan(bytes.length);
    expect((await widthOf(small, "small.jpg")).trim()).toBe("185");

    // A copy the cache pruner removed is made again on the next request.
    await removeDirectory(join(work, "data", "artwork", "s185"));
    expect((await widthOf(await fetch(sized("185")), "again.jpg")).trim()).toBe("185");

    // The server never enlarges a cover, so a width past it answers the cover's own size.
    expect((await widthOf(await fetch(sized("1280")), "large.jpg")).trim()).toBe("600");

    const head = await fetch(sized("185"), { method: "HEAD" });

    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(length));

    const part = await fetch(sized("185"), { headers: { range: "bytes=0-9" } });

    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-9/${String(length)}`);
    await part.arrayBuffer();

    const refused = await fetch(sized("186"));

    expect([refused.status, await refused.text()]).toEqual([400, "Invalid width"]);
    expect((await fetch(sized("185", "ticket=nope"))).status).toBe(401);
    const missing = "f".repeat(64);

    expect(
      (await fetch(`${baseUrl}/music/art/${missing}?ticket=${await artTicket(missing)}&w=185`))
        .status,
    ).toBe(404);
  });

  it("resize a cover that is not square by its shorter side, and never enlarge one", async () => {
    // A cover is drawn as a square crop, so the crop of each copy needs the asked size each way.
    expect(await servedArtSize("1200x600", "185")).toBe("370,185");
    expect(await servedArtSize("600x1200", "185")).toBe("185,370");
    expect(await servedArtSize("1201x599", "342")).toBe("686,342");
    expect(await servedArtSize("640x480", "1280")).toBe("640,480");
    expect(await servedArtSize("300x150", "185")).toBe("300,150");
  });

  it("serve a Cast receiver's credential the song its sender started, past the ticket's expiry", async () => {
    const ticket = await issue(TONE, "play", 2000);
    const credential = Redacted.value(await run(tokens.lend(Redacted.make(ticket))));
    const original = await fetch(streamUrl(TONE, credential));

    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toBe("audio/flac");
    await original.arrayBuffer();

    // A codec no Chromecast plays everywhere casts as the AAC transcode.
    const transcode = await fetch(streamUrl(TONE, credential, "&p=aac-320"));

    expect(transcode.status).toBe(200);
    expect((await transcode.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await fetch(streamUrl(SONG, credential))).status).toBe(403);
    expect((await fetch(streamUrl(TONE, credential, "&p=aac-320&finished=1"))).status).not.toBe(
      401,
    );

    // Tickets hold whole seconds, so this one has expired 3 s later; the receiver read the song
    // within the idle time, so its credential goes on, where the ticket starts nothing.
    await new Promise((resolve) => setTimeout(resolve, 3100));

    const later = await fetch(streamUrl(TONE, credential), { headers: { range: "bytes=0-1023" } });

    expect(later.status).toBe(206);
    await later.arrayBuffer();
    expect((await fetch(streamUrl(TONE, ticket))).status).toBe(401);
  });

  it("stop an open song once its session ends, and refuse the session's tickets and credentials after", async () => {
    const ticket = await issue(LARGE);
    const credential = await run(tokens.lend(Redacted.make(ticket)));
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
    expect((await fetch(streamUrl(LARGE, Redacted.value(credential)))).status).toBe(410);
  });
});
