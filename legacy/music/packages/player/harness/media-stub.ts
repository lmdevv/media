/**
 * A stand-in for the media service, for player tests on a branch without one:
 *
 * - `GET /media/health`: 200, or 503 while "down".
 * - `GET /media/stream/:trackId?p&exp&sig`: verifies the signed URL exactly like the media
 *   service, resolves the file with `media:trackSource`, and serves it with byte ranges. Other
 *   profiles than `original` go through the media service's real transcoder, so fragmented
 *   profiles carry their measured `X-Music-*` timing headers.
 * - `GET /fixtures/:file[?p=<profile>]`: generated test files, for engine tests that need no
 *   backend, optionally transcoded the same way.
 * - `POST /control/down` and `POST /control/up`: simulate an outage.
 * - `POST /control/fail-fmp4` and `POST /control/pass-fmp4`: answer 502 to fragmented profiles,
 *   like a failed transcode, so the player's fallback to HTML audio can be tested.
 * - `POST /control/cold`: forget the transcodes so far, so the next request for each file is a
 *   first play that streams while ffmpeg writes it.
 *
 *   node harness/media-stub.ts
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";

import { StreamTimingHeader } from "@music/commands/models";
import { verifyResource } from "@music/commands/signed-url";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { backend, fixturesDir, mediaPort } from "./config.ts";
import { generateFixtures } from "./fixtures.ts";
import { cacheTime, coldCache, transcodedStream } from "./transcode.ts";

const trackSource = makeFunctionReference<
  "query",
  { secret: string; trackId: string },
  { path: string; libraryPath: string; codec: string } | null
>("media:trackSource");

const transcodeProfiles = ["aac-320", "aac-128", "fmp4-flac", "fmp4-aac"] as const;

type TranscodeProfile = (typeof transcodeProfiles)[number];

const transcodeProfile = (value: string | null): TranscodeProfile | null =>
  transcodeProfiles.find((profile) => profile === value) ?? null;

/** The scanner's codec name for a fixture, from its extension. */
const fixtureCodecs = new Map([
  [".flac", "flac"],
  [".mp3", "mp3"],
  [".m4a", "aac"],
  [".opus", "opus"],
  [".wav", "pcm"],
]);

const contentTypes = new Map([
  [".flac", "audio/flac"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".opus", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".wav", "audio/wav"],
]);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match",
  "Access-Control-Expose-Headers": [
    "Content-Range",
    "Accept-Ranges",
    "Content-Length",
    "ETag",
    ...Object.values(StreamTimingHeader),
  ].join(", "),
};

const convex = backend === null ? null : new ConvexHttpClient(backend.convexUrl);

let down = false;

let failFragmented = false;

/** Sends `file` honouring a single `Range: bytes=start-end` request header. */
const sendFile = (
  file: string,
  range: string | undefined,
  response: ServerResponse,
  extra: Readonly<Record<string, string>> = {},
): void => {
  const size = statSync(file).size;

  const headers = {
    ...cors,
    ...extra,
    "Accept-Ranges": "bytes",
    "Content-Type": contentTypes.get(extname(file)) ?? "application/octet-stream",
  };

  const match = range === undefined ? null : /^bytes=(\d*)-(\d*)$/u.exec(range);

  if (match === null) {
    response.writeHead(200, { ...headers, "Content-Length": size });
    createReadStream(file).pipe(response);

    return;
  }

  const [, first = "", last = ""] = match;
  const start = first === "" ? Math.max(0, size - Number(last)) : Number(first);
  const end = first !== "" && last !== "" ? Math.min(Number(last), size - 1) : size - 1;

  if (start > end || start >= size) {
    response.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` }).end();

    return;
  }

  response.writeHead(206, {
    ...headers,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${size}`,
  });

  createReadStream(file, { start, end }).pipe(response);
};

/** The request headers a transcoded response depends on. */
const forwardedHeaders = ["range", "if-range", "if-none-match"] as const;

/** Sends `file` transcoded to `profile` through the media service's own response code. */
const sendTranscoded = async (
  key: string,
  file: string,
  profile: TranscodeProfile,
  codec: string,
  incoming: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const headers = new Headers();

  for (const name of forwardedHeaders) {
    const value = incoming.headers[name];

    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  const transcoded = await transcodedStream(
    new Request(`http://stub${incoming.url ?? "/"}`, { method: incoming.method ?? "GET", headers }),
    key,
    file,
    profile,
    codec,
    cacheTime(statSync(file).mtimeMs),
  );

  response.writeHead(transcoded.status, { ...cors, ...Object.fromEntries(transcoded.headers) });

  if (transcoded.body === null) {
    response.end();

    return;
  }

  // A live transcode that fails midway errors the body; the client sees the connection drop.
  Readable.from(transcoded.body)
    .on("error", () => response.destroy())
    .pipe(response);
};

const streamTrack = async (url: URL, incoming: IncomingMessage, response: ServerResponse) => {
  const trackId = decodeURIComponent(url.pathname.slice("/media/stream/".length));
  const profile = url.searchParams.get("p") ?? "";
  const expiresAt = Number(url.searchParams.get("exp"));
  const signature = url.searchParams.get("sig") ?? "";

  if (backend === null || convex === null) {
    response.writeHead(503, cors).end("No dev backend configured");

    return;
  }

  const valid = await verifyResource(
    backend.signingKey,
    { kind: "stream", trackId, profile },
    expiresAt,
    signature,
    Date.now(),
  );

  if (!valid) {
    response.writeHead(403, cors).end("Bad signature");

    return;
  }

  const source = await convex.query(trackSource, { secret: backend.mediaSecret, trackId });
  const file = source === null ? null : join(source.libraryPath, source.path);

  if (source === null || file === null || !existsSync(file)) {
    response.writeHead(404, cors).end("Not found");

    return;
  }

  const transcoded = transcodeProfile(profile);

  if (failFragmented && (transcoded === "fmp4-flac" || transcoded === "fmp4-aac")) {
    response.writeHead(502, cors).end("Transcode failed");

    return;
  }

  if (transcoded === null) sendFile(file, incoming.headers.range, response);
  else await sendTranscoded(trackId, file, transcoded, source.codec, incoming, response);
};

generateFixtures();

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const range = request.headers.range;

  if (request.method === "OPTIONS") {
    response.writeHead(204, cors).end();

    return;
  }

  if (request.method === "POST" && url.pathname.startsWith("/control/")) {
    const action = url.pathname.slice("/control/".length);

    if (action === "fail-fmp4" || action === "pass-fmp4") failFragmented = action === "fail-fmp4";
    else if (action === "cold") coldCache();
    else down = action === "down";
    response.writeHead(200, cors).end(action);

    return;
  }

  if (url.pathname === "/media/health") {
    response.writeHead(down ? 503 : 200, { ...cors, "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: !down }));

    return;
  }

  if (down) {
    // The real outage case is a refused connection; a 503 exercises the same player path.
    response.writeHead(503, cors).end("Down");

    return;
  }

  if (url.pathname.startsWith("/media/stream/")) {
    streamTrack(url, request, response).catch((error: Error) => {
      response.writeHead(500, cors).end(error.message);
    });

    return;
  }

  if (url.pathname.startsWith("/fixtures/")) {
    const name = basename(url.pathname);
    const file = join(fixturesDir, name);
    const profile = transcodeProfile(url.searchParams.get("p"));

    if (!existsSync(file)) {
      response.writeHead(404, cors).end("Not found");

      return;
    }

    if (profile === null) {
      sendFile(file, range, response);

      return;
    }

    const codec = fixtureCodecs.get(extname(file)) ?? "unknown";

    sendTranscoded(name.replaceAll(".", "-"), file, profile, codec, request, response).catch(
      (error: Error) => {
        response.writeHead(502, cors).end(error.message);
      },
    );

    return;
  }

  response.writeHead(404, cors).end("Not found");
});

server.listen(mediaPort, "127.0.0.1", () => {
  console.log(`media stub on http://127.0.0.1:${mediaPort} serving ${fixturesDir}`);
});
