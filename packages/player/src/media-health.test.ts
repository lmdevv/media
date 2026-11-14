import { createServer } from "node:http";

import { Effect, Exit, Schedule, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { isStreamRefused, mediaBaseUrl, probeMediaHealth, waitForMedia } from "./media-health";

const ListeningAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }));

const flakyMediaService = async (failures: number) => {
  let hits = 0;

  const server = createServer((request, response) => {
    if (request.url !== "/api/health") {
      response.writeHead(404).end();

      return;
    }

    hits += 1;
    response.writeHead(hits > failures ? 200 : 503).end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = ListeningAddress(server.address());

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => {
      server.close();
    },
  };
};

describe("mediaBaseUrl", () => {
  it("keeps everything before /media/music/stream/", () => {
    expect(mediaBaseUrl("http://box:8080/media/music/stream/k57abc?ticket=t&p=original")).toBe(
      "http://box:8080",
    );
    expect(mediaBaseUrl("https://media.example.com/media/music/stream/abc")).toBe(
      "https://media.example.com",
    );
  });

  it("returns null for URLs without a music stream path", () => {
    expect(mediaBaseUrl("http://box:8080/music/art/abc")).toBeNull();
    expect(mediaBaseUrl("/media/music/stream/abc")).toBeNull();
  });
});

describe("waitForMedia", () => {
  it("probes until the health check answers", async () => {
    const service = await flakyMediaService(3);

    try {
      await Effect.runPromise(waitForMedia(service.baseUrl, Schedule.spaced("10 millis")));

      expect(service.hits()).toBe(4);
    } finally {
      service.close();
    }
  });

  it("reports the status when the service answers with an error", async () => {
    const service = await flakyMediaService(1);

    try {
      const exit = await Effect.runPromiseExit(probeMediaHealth(service.baseUrl));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("503");
    } finally {
      service.close();
    }
  });

  it("fails a single probe against a server that is down", async () => {
    const exit = await Effect.runPromiseExit(probeMediaHealth("http://127.0.0.1:9"));

    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("isStreamRefused", () => {
  it("is true only for a stream URL the media server answers with 401", async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.url?.includes("expired") === true ? 401 : 206).end("ab");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const { port } = ListeningAddress(server.address());
    const base = `http://127.0.0.1:${port}/media/music/stream`;

    try {
      expect(await Effect.runPromise(isStreamRefused(`${base}/song?ticket=expired`))).toBe(true);
      expect(await Effect.runPromise(isStreamRefused(`${base}/song?ticket=later`))).toBe(false);
      expect(
        await Effect.runPromise(isStreamRefused("http://127.0.0.1:9/media/music/stream/song")),
      ).toBe(false);
    } finally {
      server.close();
    }
  });
});
