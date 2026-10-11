/**
 * A stand-in for the media service, for player tests on a branch without one:
 *
 * - `GET /media/health`: 200, or 503 while "down".
 * - `GET /media/stream/:trackId?p&exp&sig`: verifies the signed URL exactly like the media
 *   service, resolves the file with `media:trackSource`, and serves it with byte ranges. It does
 *   not transcode: every profile gets the original bytes.
 * - `GET /fixtures/:file`: generated test files, for engine tests that need no backend.
 * - `POST /control/down` and `POST /control/up`: simulate an outage.
 *
 *   node harness/media-stub.ts
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";

import { verifyResource } from "@music/commands/signed-url";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { backend, fixturesDir, mediaPort } from "./config.ts";
import { generateFixtures } from "./fixtures.ts";

const trackSource = makeFunctionReference<
  "query",
  { secret: string; trackId: string },
  { path: string; libraryPath: string } | null
>("media:trackSource");

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
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
};

const convex = backend === null ? null : new ConvexHttpClient(backend.convexUrl);

let down = false;

/** Sends `file` honouring a single `Range: bytes=start-end` request header. */
const sendFile = (file: string, range: string | undefined, response: ServerResponse): void => {
  const size = statSync(file).size;

  const headers = {
    ...cors,
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

const streamTrack = async (url: URL, range: string | undefined, response: ServerResponse) => {
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

  if (file === null || !existsSync(file)) {
    response.writeHead(404, cors).end("Not found");

    return;
  }

  sendFile(file, range, response);
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
    down = url.pathname === "/control/down";
    response.writeHead(200, cors).end(down ? "down" : "up");

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
    streamTrack(url, range, response).catch((error: Error) => {
      response.writeHead(500, cors).end(error.message);
    });

    return;
  }

  if (url.pathname.startsWith("/fixtures/")) {
    const file = join(fixturesDir, basename(url.pathname));

    if (existsSync(file)) sendFile(file, range, response);
    else response.writeHead(404, cors).end("Not found");

    return;
  }

  response.writeHead(404, cors).end("Not found");
});

server.listen(mediaPort, "127.0.0.1", () => {
  console.log(`media stub on http://127.0.0.1:${mediaPort} serving ${fixturesDir}`);
});
