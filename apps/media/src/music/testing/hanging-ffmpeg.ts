import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isRunning } from "./recording-ffmpeg.ts";

/**
 * Writes `dir/ffmpeg`: the real ffmpeg, except that a run whose arguments mention `hang` (its
 * source file's name) sleeps instead until it is killed. Every run first notes its process ID
 * under `dir/runs`. Resolves with the script's path, the number of runs started so far, and the
 * number of them still running.
 */
export const ffmpegHangingOnName = async (
  dir: string,
): Promise<{
  readonly path: string;
  readonly started: () => Promise<number>;
  readonly running: () => Promise<number>;
}> => {
  const path = join(dir, "ffmpeg");
  const runs = join(dir, "runs");

  await mkdir(runs);
  await writeFile(
    path,
    [
      "#!/bin/sh",
      `: > '${runs}'/$$`,
      `case "$*" in`,
      `  *hang*) exec sleep 600 ;;`,
      `esac`,
      `exec ffmpeg "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    path,
    started: async () => (await readdir(runs)).length,
    running: async () => (await readdir(runs)).map(Number).filter(isRunning).length,
  };
};

/**
 * Writes `dir/ffmpeg`: the real ffmpeg, except that a run whose arguments mention `held` (its
 * source file's name) stays open once ffmpeg has written everything, as a transcode still running
 * does, until released. Resolves with the script's path, the file such a run writes once ffmpeg
 * has written everything, and a release that lets it end.
 */
export const ffmpegHeldOpen = async (
  dir: string,
): Promise<{
  readonly path: string;
  readonly written: string;
  readonly release: () => Promise<void>;
}> => {
  const path = join(dir, "ffmpeg");
  const written = join(dir, "written");
  const released = join(dir, "released");

  await writeFile(
    path,
    [
      "#!/bin/sh",
      `case "$*" in`,
      `  *held*) ;;`,
      `  *) exec ffmpeg "$@" ;;`,
      `esac`,
      `ffmpeg "$@"`,
      `status=$?`,
      `: > '${written}'`,
      `while [ ! -e '${released}' ]; do sleep 0.05; done`,
      `exit $status`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return { path, written, release: () => writeFile(released, "") };
};
