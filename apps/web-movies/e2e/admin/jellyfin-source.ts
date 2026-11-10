import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseJellyfinReady } from "./jellyfin-ready";

const script = fileURLToPath(
  new URL("../../../media/scripts/serve-jellyfin-source.ts", import.meta.url),
);

const START_TIMEOUT_MS = 240_000;

/** A running Jellyfin source. */
export interface JellyfinSource {
  readonly url: string;
  /** An API key Jellyfin accepts. */
  readonly apiKey: string;
  /** Whether it is a real Jellyfin in Docker rather than the recorded server. */
  readonly docker: boolean;
  /** Stops the server and resolves once it exited. */
  readonly stop: () => Promise<void>;
}

/**
 * Generates the fixture library in `workspace` and serves Jellyfin over it; Jellyfin sees the
 * folder's `movies` and `shows` as `/media/movies` and `/media/shows`.
 *
 * @throws When the server exits or does not answer in time, with what it logged.
 */
export const startJellyfinSource = (workspace: string): Promise<JellyfinSource> => {
  const docker = process.env["MEDIA_JELLYFIN_DOCKER"] === "1";

  const child = spawn(process.execPath, [script, workspace, ...(docker ? ["--docker"] : [])], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exited = new Promise<void>((resolve) => {
    child.on("close", () => {
      resolve();
    });
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  };

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      reject(new Error(`Jellyfin did not start in time:\n${stderr}`));
      void stop();
    }, START_TIMEOUT_MS);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");

      const line = stdout.split("\n", 1)[0] ?? "";

      if (line === stdout) return;

      clearTimeout(timer);

      try {
        const ready = parseJellyfinReady(line);

        resolve({ url: ready.url, apiKey: ready.apiKey, docker, stop });
      } catch (cause) {
        reject(cause);
        void stop();
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`The Jellyfin source exited with ${String(code)}:\n${stderr}`));
    });
  });
};
