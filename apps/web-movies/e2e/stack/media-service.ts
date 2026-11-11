import { execFileSync, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MEDIA_ROUTES } from "@media/contracts/media-playback";

import { isConnected } from "./media-health";
import type { StackEnv } from "./stack-env";

const mediaDir = fileURLToPath(new URL("../../../media", import.meta.url));

const START_TIMEOUT_MS = 30_000;

/** Bundles the media service into `apps/media/dist/main.js`. */
export const buildMediaService = (): void => {
  execFileSync(process.execPath, [`${mediaDir}/scripts/build.ts`], { stdio: "pipe" });
};

/**
 * Writes the media service's stand-in ffmpeg, misbehaving as `behavior` says (its
 * `FakeFfmpegBehavior`), into a new temporary folder, and returns its path for `FFMPEG_PATH`.
 */
export const writeFakeFfmpeg = (behavior: Readonly<Record<string, number | boolean>>): string =>
  execFileSync(
    process.execPath,
    [`${mediaDir}/scripts/write-fake-ffmpeg.ts`, JSON.stringify(behavior)],
    { encoding: "utf8" },
  );

/** A running media service. */
export interface MediaService {
  /** Stops the service and resolves once it exited. */
  readonly stop: () => Promise<void>;
  /** Everything it logged so far, one JSON record per line. */
  readonly logs: () => string;
}

/**
 * Starts the built media service against `stack` with `libraryRoots` approved, and resolves once
 * it is signed in to Convex. It encodes in software whatever the stack's `.env.local` says, unless
 * `overrides`, which win over every other setting, set `HARDWARE_ACCELERATION`.
 *
 * @throws When it exits or does not connect in time, with what it logged.
 */
export const startMediaService = async (
  stack: StackEnv,
  libraryRoots: ReadonlyArray<string>,
  overrides: Readonly<Record<string, string>> = {},
): Promise<MediaService> => {
  const child = spawn(process.execPath, ["--enable-source-maps", `${mediaDir}/dist/main.js`], {
    env: {
      PATH: process.env["PATH"] ?? "",
      ...stack.mediaEnv,
      LIBRARY_ROOTS: libraryRoots.join(","),
      HARDWARE_ACCELERATION: "none",
      MIN_FREE_TRANSCODE_MB: "1",
      ...overrides,
    },
  });

  let logs = "";

  const logFile = process.env["E2E_MEDIA_LOG"];

  const collect = (chunk: Buffer): void => {
    logs += chunk.toString("utf8");

    if (logFile !== undefined && logFile !== "") appendFileSync(logFile, chunk);
  };

  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const exited = new Promise<void>((resolve) => {
    child.on("close", () => {
      resolve();
    });
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  };

  const deadline = Date.now() + START_TIMEOUT_MS;

  const connected = async (): Promise<void> => {
    if (child.exitCode !== null) throw new Error(`The media service exited:\n${logs}`);

    const ready = await fetch(`${stack.mediaUrl}${MEDIA_ROUTES.health}`)
      .then(async (response) => isConnected(await response.text()))
      .catch(() => false);

    if (ready) return;

    if (Date.now() > deadline) {
      await stop();
      throw new Error(`The media service did not connect to Convex:\n${logs}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    await connected();
  };

  await connected();

  return { stop, logs: () => logs };
};
