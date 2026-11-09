import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How the stand-in misbehaves. */
export interface FakeFfmpegBehavior {
  /**
   * Quick Sync runs encode in software for this many seconds of output, then exit with status 1,
   * as a run that fails after its first segments would.
   */
  readonly qsvFailsAfterSeconds?: number;
  /**
   * Quick Sync runs that seek to this many seconds or later exit with status 1 before writing
   * anything, as a device lost between two runs would; other Quick Sync runs encode in software.
   */
  readonly qsvFailsFromSeconds?: number;
  /** HLS runs wait this long before starting, as a slow disk or a busy encoder would. */
  readonly hlsDelayMs?: number;
  /** HLS runs exit with status 1 before writing anything, as a broken source or codec would. */
  readonly hlsFailsAtStart?: boolean;
  /** HLS runs that seek to this many seconds or later fail at start, as a damaged part would. */
  readonly hlsFailsFromSeconds?: number;
  /** HLS runs from the start of the file write only this many seconds, then finish. */
  readonly hlsFromStartSeconds?: number;
  /**
   * HLS runs write their init segment and this many fragments, then hang until stopped, as an
   * encoder that falls behind would.
   */
  readonly hlsStallsAfterFragments?: number;
  /**
   * HLS runs that stall exit with status 1 once a file named `cue` exists beside the stand-in, as
   * an encoder that fails while a request waits on it would.
   */
  readonly hlsStallsUntilCue?: true;
  /**
   * Quick Sync runs that start before this many seconds write their init segment and first
   * fragment, then exit with status 1, as a device lost right after its first fragment would;
   * later Quick Sync runs encode in software.
   */
  readonly qsvFailsAfterFirstFragmentBefore?: number;
  /** HLS runs write their init segment and first fragment, then exit with status 1. */
  readonly hlsFailsAfterFirstFragment?: true;
  /** The filter list lacks `zscale` and `tonemap`, as a build without libzimg would. */
  readonly withoutSoftwareToneMapping?: true;
}

const QSV_ONLY = [
  "-init_hw_device",
  "-filter_hw_device",
  "-hwaccel",
  "-hwaccel_output_format",
  "-forced_idr",
];

/** Runs the real tool as the service runs tools: on Linux it dies with the stand-in that ran it. */
const dyingWithParent = (realTool: string): string => `const run = (args, options) =>
  process.platform === "linux"
    ? spawnSync(
        "setpriv",
        [
          "--pdeathsig",
          "KILL",
          "--",
          "/bin/sh",
          "-c",
          '[ "$PPID" = "$1" ] || exit 1; shift; exec "$@"',
          "sh",
          String(process.pid),
          ${JSON.stringify(realTool)},
          ...args,
        ],
        options,
      )
    : spawnSync(${JSON.stringify(realTool)}, args, options);
`;

const script = (realFfmpeg: string, behavior: FakeFfmpegBehavior): string => `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

${dyingWithParent(realFfmpeg)}

const behavior = ${JSON.stringify(behavior)};
const qsvOnly = new Set(${JSON.stringify(QSV_ONLY)});
let args = process.argv.slice(2);
const hls = args.includes("hls");
const qsv =
  args.includes("h264_qsv") &&
  (behavior.qsvFailsAfterSeconds !== undefined ||
    behavior.qsvFailsFromSeconds !== undefined ||
    behavior.qsvFailsAfterFirstFragmentBefore !== undefined);
const failsLater = qsv && behavior.qsvFailsAfterSeconds !== undefined;

if (behavior.withoutSoftwareToneMapping === true && args.includes("-filters")) {
  const listed = run(args, { encoding: "utf8" });

  process.stdout.write(
    listed.stdout
      .split("\\n")
      .filter((line) => !/\\s(zscale|tonemap)\\s/.test(line))
      .join("\\n"),
  );
  process.exit(listed.status ?? 1);
}

if (hls && behavior.hlsDelayMs !== undefined) {
  await new Promise((resolve) => setTimeout(resolve, behavior.hlsDelayMs));
}

const seekTo = Number(args[args.indexOf("-ss") + 1] ?? 0);
const seeksFrom = (seconds) => seconds !== undefined && args.includes("-ss") && seekTo >= seconds;
const damaged =
  seeksFrom(behavior.hlsFailsFromSeconds) || (qsv && seeksFrom(behavior.qsvFailsFromSeconds));

if (hls && !args.includes("-ss") && behavior.hlsFromStartSeconds !== undefined) {
  const format = args.indexOf("hls") - 1;

  args = [...args.slice(0, format), "-t", String(behavior.hlsFromStartSeconds), ...args.slice(format)];
}

if (hls && (behavior.hlsFailsAtStart === true || damaged)) {
  console.error("Conversion failed!");
  process.exit(1);
}

if (qsv) {
  const software = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (qsvOnly.has(arg)) {
      index += 1;
    } else if (arg === "-vf") {
      const size = /w=(\\d+):h=(\\d+)/.exec(args[index + 1] ?? "");
      software.push("-vf", \`scale=\${size?.[1] ?? -2}:\${size?.[2] ?? -2},format=yuv420p\`);
      index += 1;
    } else if (arg === "h264_qsv") {
      software.push("libx264");
    } else if (failsLater && arg === "-f" && args[index + 1] === "hls") {
      software.push("-t", String(behavior.qsvFailsAfterSeconds), arg);
    } else {
      software.push(arg);
    }
  }

  args = software;
}

const stalls = hls && behavior.hlsStallsAfterFragments !== undefined;
const runStart = args.includes("-ss") ? seekTo : 0;
const failsAfterFirst =
  (hls && behavior.hlsFailsAfterFirstFragment === true) ||
  (qsv &&
    behavior.qsvFailsAfterFirstFragmentBefore !== undefined &&
    runStart < behavior.qsvFailsAfterFirstFragmentBefore);

if (stalls || failsAfterFirst) {
  const output = dirname(args.at(-1) ?? "");
  const aside = mkdtempSync(join(tmpdir(), "movies-fake-hls-"));
  const redirected = args.map((arg) => (arg.startsWith(output) ? aside + arg.slice(output.length) : arg));

  let status = 0;

  try {
    status = run(redirected, { stdio: "inherit" }).status ?? 1;

    const kept = stalls ? behavior.hlsStallsAfterFragments : 1;
    const names = ["init.mp4", ...Array.from({ length: kept }, (_, index) => \`f\${index}.m4s\`)];

    for (const name of status === 0 ? names : []) {
      // Not copyFileSync, whose fchown the NixOS unit's system call filter denies.
      writeFileSync(join(output, \`\${name}.tmp\`), readFileSync(join(aside, name)));
      renameSync(join(output, \`\${name}.tmp\`), join(output, name));
    }
  } finally {
    rmSync(aside, { recursive: true, force: true });
  }

  if (status !== 0) process.exit(status);
  if (failsAfterFirst) process.exit(1);
  const cue = join(dirname(process.argv[1] ?? ""), "cue");

  setInterval(() => {
    if (behavior.hlsStallsUntilCue === true && existsSync(cue)) process.exit(1);
  }, behavior.hlsStallsUntilCue === true ? 50 : 60_000);
} else {
  const result = run(args, { stdio: "inherit" });

  process.exit(failsLater ? 1 : (result.status ?? 1));
}
`;

/** Writes the stand-in into a new temporary folder and returns its path, for `FFMPEG_PATH`. */
export const writeFakeFfmpeg = async (behavior: FakeFfmpegBehavior): Promise<string> => {
  const file = join(await mkdtemp(join(tmpdir(), "movies-fake-ffmpeg-")), "ffmpeg.mjs");

  await writeFile(file, script(process.env["FFMPEG_PATH"] ?? "ffmpeg", behavior));
  await chmod(file, 0o755);

  return file;
};

const ffprobeScript = (
  realFfprobe: string,
  packetScanDelayMs: number,
): string => `#!/usr/bin/env node
import { spawnSync } from "node:child_process";

${dyingWithParent(realFfprobe)}
const args = process.argv.slice(2);

if (args.includes("packet=pts_time,flags")) {
  await new Promise((resolve) => setTimeout(resolve, ${String(packetScanDelayMs)}));
}

const result = run(args, { stdio: "inherit" });

process.exit(result.status ?? 1);
`;

/**
 * Writes a stand-in `FFPROBE_PATH` whose packet scans (keyframe indexing) take
 * `packetScanDelayMs` longer, as on a large file over a slow share; returns its path.
 */
export const writeSlowFfprobe = async (packetScanDelayMs: number): Promise<string> => {
  const file = join(await mkdtemp(join(tmpdir(), "movies-fake-ffprobe-")), "ffprobe.mjs");

  await writeFile(file, ffprobeScript(process.env["FFPROBE_PATH"] ?? "ffprobe", packetScanDelayMs));
  await chmod(file, 0o755);

  return file;
};
