import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
   * HLS runs ask the muxer for fragments this many seconds long (`-hls_time`) rather than one per
   * keyframe, so it cuts at none of the planned segment starts within that span.
   */
  readonly hlsFragmentSeconds?: number;
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
  readonly withoutCpuToneMap?: true;
  /** Runs these rules pick fail, hang, or start late, as a broken or slow stage would. */
  readonly rules?: ReadonlyArray<RunRule>;
  /** Each run appends its arguments, one JSON array per line, to `invocationsOf` the stand-in. */
  readonly logInvocations?: true;
}

/**
 * A rule for runs whose arguments, as the service wrote them, contain `token`. `runs` picks HLS
 * runs, capability probes (`-progress` into the null output), or any run. A matching run waits
 * `delayMs`, then writes `stderr` if given; then with `signal` it is killed by that signal, with
 * `hang` it never exits until killed, with `exitCode` it exits with that status, with `stderr`
 * alone it exits with status 1, and otherwise it runs as usual. A rule with `armedBy` applies only
 * once a rule that `arm`s that name has matched, so a probe can pass at start and fail after a
 * stream's failure; `limit` caps how many runs a rule matches.
 */
export interface RunRule {
  readonly token: string;
  readonly runs: "hls" | "probe" | "any";
  readonly stderr?: string;
  readonly signal?: NodeJS.Signals;
  readonly exitCode?: number;
  readonly hang?: true;
  readonly delayMs?: number;
  readonly arm?: string;
  readonly armedBy?: string;
  readonly limit?: number;
}

/** Options that open or use a GPU, dropped with their values when the stand-in plays the GPU. */
const GPU_ONLY = [
  "-init_hw_device",
  "-filter_hw_device",
  "-hwaccel",
  "-hwaccel_output_format",
  "-hwaccel_device",
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
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

${dyingWithParent(realFfmpeg)}

const behavior = ${JSON.stringify(behavior)};
const gpuOnly = new Set(${JSON.stringify(GPU_ONLY)});
const here = dirname(process.argv[1] ?? "");
const asked = process.argv.slice(2);
let args = asked;
const hls = args.includes("hls");
const probe = args.includes("-progress") && args.includes("null");

if (behavior.logInvocations === true) {
  appendFileSync(join(here, "invocations.jsonl"), JSON.stringify(asked) + "\\n");
}

for (const [index, rule] of (behavior.rules ?? []).entries()) {
  const runs = rule.runs === "any" || (rule.runs === "hls" ? hls : probe);
  const armed = rule.armedBy === undefined || existsSync(join(here, "armed-" + rule.armedBy));
  const matched = Array.from({ length: rule.limit ?? 0 }, (_, n) => join(here, "rule-" + index + "-" + n));
  const spare = matched.find((marker) => !existsSync(marker));

  if (runs && armed && asked.join(" ").includes(rule.token) && (rule.limit === undefined || spare !== undefined)) {
    if (spare !== undefined) writeFileSync(spare, "");
    if (rule.arm !== undefined) writeFileSync(join(here, "armed-" + rule.arm), "");
    if (rule.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
    if (rule.stderr !== undefined) process.stderr.write(rule.stderr + "\\n");
    // A core size limit of 1 makes Linux skip the core dump, which a dump collector such as
    // systemd-coredump would otherwise take seconds to write before the run ends.
    if (rule.signal !== undefined) spawnSync("prlimit", ["--pid", String(process.pid), "--core=1:1"]);
    if (rule.signal !== undefined) process.kill(process.pid, rule.signal);
    if (rule.hang === true || rule.signal !== undefined) await new Promise(() => setInterval(() => {}, 60_000));
    if (rule.exitCode !== undefined) process.exit(rule.exitCode);
    if (rule.stderr !== undefined) process.exit(1);
    break;
  }
}

// The stand-in plays any Quick Sync or VA-API device in software, so the service's probes and
// runs work without one: GPU options go, GPU filters become their software equivalents.
const optionsOf = (text) =>
  Object.fromEntries(text.split(":").map((pair) => [pair.split("=")[0], pair.split("=")[1]]));
const inSoftware = (options) => {
  const parts = [];
  if (options.w !== undefined && options.h !== undefined) parts.push("scale=" + options.w + ":" + options.h);
  if (options.format !== undefined) parts.push("format=" + (options.format === "p010" ? "p010le" : options.format));

  return parts.length === 0 ? "null" : parts.join(",");
};
const graphInSoftware = (text) =>
  text
    .replace(/vpp_qsv=([^,;\\[]*)/g, (_, options) => inSoftware(optionsOf(options)))
    .replace(/scale_vaapi=([^,;\\[]*)/g, (_, options) => inSoftware(optionsOf(options)))
    .replace(/tonemap_vaapi=[^,;\\[]*/g, "format=nv12")
    .replace(/hwupload(=[^,;\\[]*)?/g, "null")
    .replace(/hwdownload/g, "null")
    .replace(/format=(qsv|vaapi)/g, "null");
const played = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];

  if (gpuOnly.has(arg)) {
    index += 1;
  } else if ((arg === "-vf" || arg === "-filter_complex") && index + 1 < args.length) {
    played.push(arg, graphInSoftware(args[index + 1]));
    index += 1;
  } else if (arg === "h264_qsv" || arg === "h264_vaapi") {
    played.push("libx264");
  } else {
    played.push(arg);
  }
}

args = played;
const qsv =
  hls &&
  asked.includes("h264_qsv") &&
  (behavior.qsvFailsAfterSeconds !== undefined ||
    behavior.qsvFailsFromSeconds !== undefined ||
    behavior.qsvFailsAfterFirstFragmentBefore !== undefined);
const failsLater = qsv && behavior.qsvFailsAfterSeconds !== undefined;

// Listings name the GPU components the stand-in plays, whatever the real build has.
const emulated = {
  "-hwaccels": "qsv\\nvaapi\\n",
  "-filters": [
    " .. vpp_qsv           V->V       played in software",
    " .. scale_vaapi       V->V       played in software",
    " .. tonemap_vaapi     V->V       played in software",
    " .. hwupload          V->V       played in software",
    " .. hwdownload        V->V       played in software",
    "",
  ].join("\\n"),
  "-codecs": [
    " DEV.L. h264                 played (decoders: h264_qsv) (encoders: h264_qsv h264_vaapi)",
    " DEV.L. hevc                 played (decoders: hevc_qsv)",
    " DEV.L. av1                  played (decoders: av1_qsv)",
    " DEV.L. vp9                  played (decoders: vp9_qsv)",
    " DEV.L. mpeg2video           played (decoders: mpeg2_qsv)",
    "",
  ].join("\\n"),
};
const listing = Object.keys(emulated).find((flag) => args.includes(flag));

if (listing !== undefined) {
  const listed = run(args, { encoding: "utf8" });
  const lines = (listed.stdout + emulated[listing]).split("\\n");

  process.stdout.write(
    (behavior.withoutCpuToneMap === true && listing === "-filters"
      ? lines.filter((line) => !/\\s(zscale|tonemap)\\s/.test(line))
      : lines
    ).join("\\n"),
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

if (hls && behavior.hlsFragmentSeconds !== undefined) {
  const value = args.indexOf("-hls_time") + 1;

  args = args.map((arg, index) => (index === value ? String(behavior.hlsFragmentSeconds) : arg));
}

if (hls && (behavior.hlsFailsAtStart === true || damaged)) {
  console.error("Conversion failed!");
  process.exit(1);
}

if (failsLater) {
  const format = args.indexOf("hls") - 1;

  args = [...args.slice(0, format), "-t", String(behavior.qsvFailsAfterSeconds), ...args.slice(format)];
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
  const aside = mkdtempSync(join(tmpdir(), "media-fake-hls-"));
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

/** The file a stand-in that logs its invocations writes them to. */
export const invocationsOf = (ffmpeg: string): string => join(dirname(ffmpeg), "invocations.jsonl");

/** Writes the stand-in into a new temporary folder and returns its path, for `FFMPEG_PATH`. */
export const writeFakeFfmpeg = async (behavior: FakeFfmpegBehavior): Promise<string> => {
  const file = join(await mkdtemp(join(tmpdir(), "media-fake-ffmpeg-")), "ffmpeg.mjs");

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
  const file = join(await mkdtemp(join(tmpdir(), "media-fake-ffprobe-")), "ffprobe.mjs");

  await writeFile(file, ffprobeScript(process.env["FFPROBE_PATH"] ?? "ffprobe", packetScanDelayMs));
  await chmod(file, 0o755);

  return file;
};
