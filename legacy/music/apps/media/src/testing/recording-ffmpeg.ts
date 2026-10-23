/**
 * An ffmpeg that records its runs, for tests that check no ffmpeg is left running: a shell
 * script standing in for `FFMPEG_PATH`. Effect-free so it can use `node:fs` directly.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** True while a process with this ID exists. */
export const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/**
 * Writes `dir/ffmpeg`: the real ffmpeg, which first notes its process ID under `dir/runs`.
 * Resolves with the script's path and a check that lists the recorded runs still running.
 */
export const ffmpegRecordingRuns = async (
  dir: string,
): Promise<{ readonly path: string; readonly running: () => Promise<ReadonlyArray<number>> }> => {
  const path = join(dir, "ffmpeg");
  const runs = join(dir, "runs");

  await mkdir(runs);
  // `exec` keeps the process ID, so the recorded one is ffmpeg's.
  await writeFile(path, ["#!/bin/sh", `: > '${runs}'/$$`, `exec ffmpeg "$@"`, ""].join("\n"), {
    mode: 0o755,
  });

  return {
    path,
    running: async () => (await readdir(runs)).map(Number).filter(isRunning),
  };
};
