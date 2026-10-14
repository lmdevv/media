/**
 * A stand-in for the media service's HTTP API, for the Playwright suite. That suite's catalog
 * comes from `packages/backend/scripts/seed.ts`, which has no audio files, while the app only lets
 * people play once `<media>/health` answers and plays what `<media>/stream/:id` returns. So this
 * answers the health check, and serves every track's original profile as the same minute of a
 * quiet tone (a WAV, with byte ranges). Transcoded profiles answer 404, as for a profile the
 * server cannot make, so the player falls back to HTML audio. The real media service, with real
 * files and signatures checked, is covered by the stack suite (`apps/web/e2e-stack`).
 *
 *   node e2e/media-stand-in.ts <port>
 */
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

const port = Number(process.argv[2] ?? "4100");

const SAMPLE_RATE = 8000;

const SECONDS = 60;

/** 16-bit mono PCM in a RIFF/WAVE container. */
const tone = (): Buffer => {
  const samples = SAMPLE_RATE * SECONDS;
  const data = samples * 2;
  const wav = Buffer.alloc(44 + data);

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + data, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(data, 40);

  for (let index = 0; index < samples; index += 1) {
    wav.writeInt16LE(
      Math.round(800 * Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE)),
      44 + index * 2,
    );
  }

  return wav;
};

const audio = tone();

const send = (response: ServerResponse, range: string | undefined): void => {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range ?? "");
  const headers = { "Content-Type": "audio/wav", "Accept-Ranges": "bytes" };

  if (match === null) {
    response.writeHead(200, { ...headers, "Content-Length": audio.length }).end(audio);

    return;
  }

  const [, from = "", to = ""] = match;
  const start = from === "" ? Math.max(0, audio.length - Number(to)) : Number(from);
  const end = from !== "" && to !== "" ? Math.min(Number(to), audio.length - 1) : audio.length - 1;

  if (start > end) {
    response.writeHead(416, { "Content-Range": `bytes */${audio.length}` }).end();

    return;
  }

  response
    .writeHead(206, {
      ...headers,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${audio.length}`,
    })
    .end(audio.subarray(start, end + 1));
};

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://stand-in");

  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Range, If-Range");
  response.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Range, Accept-Ranges, Content-Length",
  );

  if (request.method === "OPTIONS") {
    response.writeHead(204).end();

    return;
  }

  if (url.pathname === "/media/health") {
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');

    return;
  }

  if (url.pathname.startsWith("/media/stream/") && url.searchParams.get("p") === "original") {
    send(response, request.headers.range);

    return;
  }

  response.writeHead(404).end();
}).listen(port, "127.0.0.1");
