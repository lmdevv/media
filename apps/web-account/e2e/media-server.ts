import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MEDIA_ROUTES } from "@media/contracts/media-playback";

import { isConnected } from "./media-health";

const mediaDir = fileURLToPath(new URL("../../media", import.meta.url));

const START_TIMEOUT_MS = 30_000;

const readEnvFile = (path: string): Readonly<Record<string, string>> => {
  if (!existsSync(path)) return {};

  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        const separator = line.indexOf("=");

        return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
      }),
  );
};

/** The media server's environment as `scripts/dev-stack.sh` wrote it, or null without a stack. */
export const mediaEnv = (): Readonly<Record<string, string>> | null => {
  const env = readEnvFile(`${mediaDir}/.env.local`);

  return env["MEDIA_SERVICE_API_KEY"] === undefined || env["MEDIA_BASE_URL"] === undefined
    ? null
    : env;
};

/** A running media server. */
export interface MediaServer {
  readonly url: string;
  /** Stops the server and resolves once it exited. */
  readonly stop: () => Promise<void>;
}

/**
 * Bundles the media server from source and starts it on the stack's settings
 * (`apps/media/.env.local`), encoding in software, and resolves once it signed in to the core.
 *
 * @throws When it exits or does not connect in time, with what it logged.
 */
export const startMediaServer = async (
  env: Readonly<Record<string, string>>,
): Promise<MediaServer> => {
  execFileSync(process.execPath, [`${mediaDir}/scripts/build.ts`], { stdio: "pipe" });

  const url = env["MEDIA_BASE_URL"] ?? "";

  const child = spawn(process.execPath, ["--enable-source-maps", `${mediaDir}/dist/main.js`], {
    env: {
      PATH: process.env["PATH"] ?? "",
      ...env,
      HARDWARE_ACCELERATION: "none",
      MIN_FREE_TRANSCODE_MB: "1",
    },
  });

  let logs = "";

  const collect = (chunk: Buffer): void => {
    logs += chunk.toString("utf8");
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
    if (child.exitCode !== null) throw new Error(`The media server exited:\n${logs}`);

    const ready = await fetch(`${url}${MEDIA_ROUTES.health}`)
      .then(async (response) => isConnected(await response.text()))
      .catch(() => false);

    if (ready) return;

    if (Date.now() > deadline) {
      await stop();
      throw new Error(`The media server did not connect to the core:\n${logs}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    await connected();
  };

  await connected();

  return { url, stop };
};
