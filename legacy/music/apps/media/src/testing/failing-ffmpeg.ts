/**
 * An ffmpeg that fails part-way, for tests of a transcode that dies after its first bytes: a
 * shell script standing in for `FFMPEG_PATH`. Effect-free so it can use `node:fs` directly.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Writes `dir/ffmpeg`: the real ffmpeg, except that the first AAC transcode (the one writing
 * ADTS beside the cached file) is killed `afterSeconds` into its run. Later runs go through.
 * Resolves with the script's path.
 */
export const ffmpegFailingOnce = async (dir: string, afterSeconds: number): Promise<string> => {
  const path = join(dir, "ffmpeg");
  const flag = join(dir, "failed-once");

  await writeFile(
    path,
    [
      "#!/bin/sh",
      `case "$*" in`,
      `  *"f=adts]pipe:3"*)`,
      `    if [ ! -e '${flag}' ]; then`,
      `      : > '${flag}'`,
      `      ffmpeg "$@" &`,
      `      sleep ${String(afterSeconds)}`,
      `      kill -9 $!`,
      `      wait $!`,
      `      exit 137`,
      `    fi`,
      `    ;;`,
      `esac`,
      `exec ffmpeg "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return path;
};
