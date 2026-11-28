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
  /**
   * The filter list names libplacebo, and the stand-in plays its tone map in software as a format
   * conversion to NV12, as on a GPU whose Vulkan the probes prove.
   */
  readonly withPlacebo?: true;
  /**
   * The Vulkan device a run that opens one names, as ffmpeg logs its pick: `Stand-in GPU
   * (discrete)` unless given, such as `llvmpipe (LLVM 21.1.8, 256 bits) (software)`.
   */
  readonly vulkanDevice?: string;
  /** Runs these rules pick fail, hang, or start late, as a broken or slow stage would. */
  readonly rules?: ReadonlyArray<RunRule>;
  /**
   * Probes whose arguments hold this text read back a black picture, as an overlay that ignores
   * the subtitle's transparency draws one.
   */
  readonly blankReadback?: string;
  /** Each run appends its arguments, one JSON array per line, to `invocationsOf` the stand-in. */
  readonly logInvocations?: true;
}

/**
 * A rule for runs whose arguments, as the service wrote them, contain `token`. `runs` picks HLS
 * runs, capability probes (`-progress` into the null output), or any run. A matching run waits
 * `delayMs`, then writes `stderr` if given, or the text of the file `stderrFrom` names beside the
 * stand-in as it is when the run starts; then with `signal` it is killed by that signal, with
 * `hang` it never exits until killed, with `exitCode` it exits with that status, with `stderr` or
 * `stderrFrom` alone it exits with status 1, and otherwise it runs as usual. With
 * `afterFragments`, a matching HLS run first writes its init segment and that many fragments, then
 * writes `stderr` and exits with status 1, as a stage that fails partway through would. A rule
 * with `armedBy` applies only once a rule that `arm`s that name has matched, so a probe can pass at
 * start and fail after a stream's failure; `limit` caps how many runs a rule matches. In `stderr`,
 * `{Parsed:<filter>}` names the run's first `<filter>` as ffmpeg's log does (`Parsed_<filter>_<n>`,
 * `n` its place in the graph).
 */
export interface RunRule {
  readonly token: string;
  readonly runs: "hls" | "probe" | "any";
  readonly stderr?: string;
  readonly stderrFrom?: string;
  readonly signal?: NodeJS.Signals;
  readonly exitCode?: number;
  readonly hang?: true;
  readonly delayMs?: number;
  readonly arm?: string;
  readonly armedBy?: string;
  readonly limit?: number;
  readonly afterFragments?: number;
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
  fstatSync,
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
const probe = args.includes("-progress") && (args.includes("null") || args.includes("rawvideo"));

// A run that opens a Vulkan device names the one it picked, as ffmpeg does at the verbose level,
// after the 4 KiB or so ffmpeg 7.1 logs opening VA-API, Quick Sync, and Vulkan's layers first.
if (asked.some((arg, index) => asked[index - 1] === "-init_hw_device" && arg.startsWith("vulkan="))) {
  process.stderr.write(
    "[AVHWDeviceContext @ 0x1] Using instance extension VK_KHR_portability_enumeration\\n".repeat(64) +
      "[AVHWDeviceContext @ 0x1] Device 0 selected: " +
      (behavior.vulkanDevice ?? "Stand-in GPU (discrete)") +
      " (0x1)\\n",
  );
}

if (behavior.logInvocations === true) {
  appendFileSync(join(here, "invocations.jsonl"), JSON.stringify(asked) + "\\n");
}

let failsPartway;

// The graph's filters in the order ffmpeg names them, labels left out, so a rule's stderr can name
// one as its log does.
const graphText = asked[asked.findIndex((arg) => arg === "-vf" || arg === "-filter_complex") + 1] ?? "";
const graphFilters = graphText
  .split(/[;,]/)
  .map((part) => part.replace(/^(\\[[^\\]]*\\])+/, "").split("=")[0].replace(/\\[[^\\]]*\\]$/, ""));
const parsedNames = (text) =>
  text?.replace(/\\{Parsed:([a-z0-9_]+)\\}/g, (_, name) => "Parsed_" + name + "_" + graphFilters.indexOf(name));

for (const [index, rule] of (behavior.rules ?? []).entries()) {
  const runs = rule.runs === "any" || (rule.runs === "hls" ? hls : probe);
  const armed = rule.armedBy === undefined || existsSync(join(here, "armed-" + rule.armedBy));
  const matched = Array.from({ length: rule.limit ?? 0 }, (_, n) => join(here, "rule-" + index + "-" + n));
  const spare = matched.find((marker) => !existsSync(marker));

  if (runs && armed && asked.join(" ").includes(rule.token) && (rule.limit === undefined || spare !== undefined)) {
    if (spare !== undefined) writeFileSync(spare, "");
    if (rule.arm !== undefined) writeFileSync(join(here, "armed-" + rule.arm), "");
    if (hls && rule.afterFragments !== undefined) {
      failsPartway = rule;
      break;
    }
    if (rule.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
    const stderr = rule.stderrFrom === undefined ? parsedNames(rule.stderr) : readFileSync(join(here, rule.stderrFrom), "utf8");
    if (stderr !== undefined) process.stderr.write(stderr + "\\n");
    // A core size limit of 1 makes Linux skip the core dump, which a dump collector such as
    // systemd-coredump would otherwise take seconds to write before the run ends.
    if (rule.signal !== undefined) spawnSync("prlimit", ["--pid", String(process.pid), "--core=1:1"]);
    if (rule.signal !== undefined) process.kill(process.pid, rule.signal);
    if (rule.hang === true || rule.signal !== undefined) await new Promise(() => setInterval(() => {}, 60_000));
    if (rule.exitCode !== undefined) process.exit(rule.exitCode);
    if (stderr !== undefined) process.exit(1);
    break;
  }
}

// The stand-in plays any Quick Sync or VA-API device in software, so the service's probes and
// runs work without one: GPU options go, GPU filters become their software equivalents (an overlay
// scaling and placing its top input as the GPU overlay's options say), and GPU encoders of H.264
// and HEVC become libx264 and libx265.
const SOFTWARE_DEINTERLACE = "bwdif=mode=send_frame:deint=interlaced";
const optionsOf = (text) =>
  Object.fromEntries(text.split(":").map((pair) => [pair.split("=")[0], pair.split("=")[1]]));
const inSoftware = (options) => {
  const parts = [];
  if (options.deinterlace !== undefined) parts.push(SOFTWARE_DEINTERLACE);
  if (options.w !== undefined && options.h !== undefined) parts.push("scale=" + options.w + ":" + options.h);
  if (options.format !== undefined) parts.push("format=" + (options.format === "p010" ? "p010le" : options.format));

  return parts.length === 0 ? "null" : parts.join(",");
};
const overlayInSoftware = (main, top, text) => {
  const options = optionsOf(text);
  const place = options.x === undefined ? "" : "x=" + options.x + ":y=" + options.y + ":";

  if (options.w === "main_w" && options.h === "main_h") {
    return "[" + top + "][" + main + "]scale2ref=w=rw:h=rh[played_top][played_main];" +
      "[played_main][played_top]overlay=eof_action=pass:repeatlast=0";
  }
  if (options.w !== undefined && options.h !== undefined) {
    return "[" + top + "]scale=" + options.w + ":" + options.h + "[played_top];" +
      "[" + main + "][played_top]overlay=" + place + "eof_action=pass:repeatlast=0";
  }

  return "[" + main + "][" + top + "]overlay=" + place + "eof_action=pass:repeatlast=0";
};
const graphInSoftware = (text) =>
  text
    .replace(
      /\\[([^\\]]+)\\]\\[([^\\]]+)\\]overlay_(?:qsv|vaapi)=((?:\\\\.|[^,;\\[\\\\])*)/g,
      (_, main, top, options) => overlayInSoftware(main, top, options),
    )
    .replace(/vpp_qsv=([^,;\\[]*)/g, (_, options) => inSoftware(optionsOf(options)))
    .replace(/scale_vaapi=([^,;\\[]*)/g, (_, options) => inSoftware(optionsOf(options)))
    .replace(/tonemap_vaapi=[^,;\\[]*/g, "format=nv12")
    .replace(/libplacebo=[^,;\\[]*/g, "format=nv12")
    .replace(/deinterlace_vaapi=[^,;\\[]*/g, SOFTWARE_DEINTERLACE)
    .replace(/overlay_(?:qsv|vaapi)=(?:\\\\.|[^,;\\[\\\\])*/g, "overlay=eof_action=pass:repeatlast=0")
    .replace(/hwupload(=[^,;\\[]*)?/g, "null")
    .replace(/hwmap(=[^,;\\[]*)?/g, "null")
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
  } else if (arg === "hevc_qsv" || arg === "hevc_vaapi") {
    played.push("libx265");
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

// Listings name the GPU components the stand-in plays, whatever the real build has. It plays no
// Vulkan device, so they never name libplacebo, whose rows need one, though the build has it.
const emulated = {
  "-hwaccels": "qsv\\nvaapi\\n",
  "-filters": [
    " .. vpp_qsv           V->V       played in software",
    " .. scale_vaapi       V->V       played in software",
    " .. tonemap_vaapi     V->V       played in software",
    " .. deinterlace_vaapi V->V       played in software",
    " .. overlay_qsv       VV->V      played in software",
    " .. overlay_vaapi     VV->V      played in software",
    " .. hwupload          V->V       played in software",
    " .. hwdownload        V->V       played in software",
    " .. hwmap             V->V       played in software",
    "",
  ].join("\\n"),
  "-codecs": [
    " DEV.L. h264                 played (decoders: h264_qsv) (encoders: h264_qsv h264_vaapi)",
    " DEV.L. hevc                 played (decoders: hevc_qsv) (encoders: hevc_qsv hevc_vaapi)",
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

  // With libplacebo played, the listing names it whatever the build has; otherwise it never does.
  const hidden =
    behavior.withoutCpuToneMap === true
      ? /\\s(zscale|tonemap|libplacebo)\\s/
      : /\\slibplacebo\\s/;
  const shown =
    listing === "-filters" && behavior.withPlacebo === true
      ? " .. libplacebo        V->V       played in software\\n"
      : "";

  process.stdout.write(
    (listing === "-filters" ? lines.filter((line) => !hidden.test(line)) : lines).join("\\n") + shown,
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

if (stalls || failsAfterFirst || failsPartway !== undefined) {
  const output = dirname(args.at(-1) ?? "");
  const aside = mkdtempSync(join(tmpdir(), "media-fake-hls-"));
  const redirected = args.map((arg) => (arg.startsWith(output) ? aside + arg.slice(output.length) : arg));

  let status = 0;

  try {
    status = run(redirected, { stdio: "inherit" }).status ?? 1;

    const kept = stalls
      ? behavior.hlsStallsAfterFragments
      : (failsPartway?.afterFragments ?? 1);
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
  if (failsPartway !== undefined) {
    process.stderr.write((parsedNames(failsPartway.stderr) ?? "Conversion failed!") + "\\n");
    process.exit(1);
  }
  if (failsAfterFirst) process.exit(1);
  const cue = join(dirname(process.argv[1] ?? ""), "cue");

  setInterval(() => {
    if (behavior.hlsStallsUntilCue === true && existsSync(cue)) process.exit(1);
  }, behavior.hlsStallsUntilCue === true ? 50 : 60_000);
} else {
  // A run the service reads from file descriptor 3 (\`pipe:3\`) hands it on to the real tool.
  const piped = (() => {
    try {
      fstatSync(3);

      return true;
    } catch {
      return false;
    }
  })();
  const result = run(args, { stdio: piped ? ["inherit", "inherit", "inherit", 3] : "inherit" });
  const readback = args.at(-1) ?? "";

  if (
    probe &&
    behavior.blankReadback !== undefined &&
    asked.join(" ").includes(behavior.blankReadback) &&
    args.includes("rawvideo") &&
    existsSync(readback)
  ) {
    writeFileSync(readback, new Uint8Array(readFileSync(readback).length));
  }

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
