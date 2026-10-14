/**
 * An ffmpeg that never finishes some runs, for tests of the transcode slots and their timeout: a
 * shell script standing in for `FFMPEG_PATH`. Effect-free so it can use `node:fs` directly.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Writes `dir/ffmpeg`: the real ffmpeg, except that a run whose arguments mention `hang` (its
 * source file's name) sleeps instead until it is killed. Every run first notes itself under
 * `dir/runs`. Resolves with the script's path and the number of runs started so far.
 */
export const ffmpegHangingOnName = async (
  dir: string,
): Promise<{ readonly path: string; readonly started: () => Promise<number> }> => {
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

  return { path, started: async () => (await readdir(runs)).length };
};
