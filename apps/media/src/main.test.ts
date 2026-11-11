import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildService,
  makeTempDir,
  removeDir,
  startMedia,
  type MediaProcess,
} from "./testing/stack-processes.ts";

let workspace = "";

beforeAll(async () => {
  buildService();
  workspace = await makeTempDir("movies-media-main-");
  await mkdir(join(workspace, "library"));
}, 60_000);

afterAll(() => removeDir(workspace));

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      server.close(() => {
        if (address instanceof Object) resolve(address.port);
        else reject(new Error("The port probe is not listening on a TCP port"));
      });
    });
  });

const standaloneEnv = (port: number) => ({
  PORT: String(port),
  MEDIA_BASE_URL: `http://127.0.0.1:${port}`,
  LIBRARY_ROOTS: join(workspace, "library"),
  DATA_DIR: join(workspace, "data"),
  TRANSCODE_DIR: join(workspace, "transcode"),
  HARDWARE_ACCELERATION: "none",
});

const listening = (media: MediaProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    const check = (): void => {
      if (media.logs().includes("Listening on")) resolve();
      else if (media.child.exitCode !== null) reject(new Error(media.logs()));
      else setTimeout(check, 50);
    };

    check();
  });

describe("media service process", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "exits 0 after a clean %s shutdown, so systemd and Docker record a stop, not a failure",
    async (signal) => {
      const media = startMedia(standaloneEnv(await freePort()));

      await listening(media);
      await media.stop(signal);

      expect({ code: media.child.exitCode, signal: media.child.signalCode }).toEqual({
        code: 0,
        signal: null,
      });
    },
    30_000,
  );

  it("exits 1 when its configuration is invalid", async () => {
    const { MEDIA_BASE_URL: _omitted, ...env } = standaloneEnv(await freePort());
    const media = startMedia(env);

    await once(media.child, "close");

    expect(media.child.exitCode).toBe(1);
  }, 30_000);

  it.each([
    ["MEDIA_SERVICE_API_KEY", { MEDIA_TICKET_KEYS: "k1:test" }],
    ["MEDIA_TICKET_KEYS", { MEDIA_SERVICE_API_KEY: "mk_test" }],
  ] as const)(
    "exits 1 naming %s when CONVEX_URL is set without it",
    async (missing, given) => {
      const media = startMedia({
        ...standaloneEnv(await freePort()),
        CONVEX_URL: "http://127.0.0.1:9",
        ...given,
      });

      await once(media.child, "close");

      expect(media.child.exitCode).toBe(1);
      expect(media.logs()).toContain(`${missing} is not`);
    },
    30_000,
  );
});
