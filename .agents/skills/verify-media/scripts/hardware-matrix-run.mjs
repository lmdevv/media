#!/usr/bin/env node
// Measures the hardware matrix (hardware-matrix.mjs) on one side and writes the grid. For each
// path it switches the side to that path (`verify-media.sh hardware`), then plays each cell's
// fixture as a client would: a ticket from `media movies play start`, `POST /api/playback/negotiate`
// with the row's capabilities, the playlist, the init segment, and a few seconds of segments from
// the start and after a seek. ffprobe and ffmpeg read the bytes; a watcher in the container records
// each ffmpeg run's arguments and GPU engine time. verify-media.sh passes everything but --paths
// and --rows.
//
//   hardware-matrix-run.mjs --helper <verify-media.sh> --side S --state DIR --container NAME --url URL
//     --cli <media.js> --image IMG --out DIR --run RUN --uid U --gid G [--paths cpu,qsv,vaapi]
//     [--rows decode,scale] [--grid-only]
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { cliEnv } from "./core-seed.mjs";
import * as Matrix from "./hardware-matrix.mjs";

const { values: flags } = parseArgs({
  strict: true,
  options: {
    helper: { type: "string" },
    side: { type: "string" },
    state: { type: "string" },
    container: { type: "string" },
    url: { type: "string" },
    cli: { type: "string" },
    image: { type: "string" },
    out: { type: "string" },
    run: { type: "string" },
    uid: { type: "string" },
    gid: { type: "string" },
    paths: { type: "string", default: Object.keys(Matrix.PATHS).join(",") },
    rows: { type: "string" },
    "grid-only": { type: "boolean", default: false },
  },
});

const say = (message) => process.stderr.write(`hardware-matrix: ${message}\n`);
const fail = (message) => {
  say(message);
  process.exit(1);
};

// ------------------------------------------------------------------------------- side effects

const docker = (args, options = {}) =>
  spawnSync("docker", args, { encoding: "utf8", maxBuffer: 1 << 28, timeout: 300_000, ...options });

const inContainer = (args, options) => docker(["exec", flags.container, ...args], options);

const media = (...args) => {
  const result = spawnSync("node", [flags.cli, ...args], {
    encoding: "utf8",
    env: cliEnv(flags.state, "lucia"),
    timeout: 120_000,
    maxBuffer: 1 << 26,
  });
  if (result.status !== 0) {
    throw new Error(`media ${args.slice(0, 3).join(" ")} exited ${result.status}: ${result.stderr.trim().split("\n")[0]}`);
  }
  return JSON.parse(result.stdout || "null");
};

const tool = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: "utf8", maxBuffer: 1 << 28, timeout: 300_000, ...options });

const post = async (route, body) => {
  try {
    const response = await fetch(`${flags.url}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: response.status, ok: response.ok, body: parsed, text };
  } catch (error) {
    return { status: 0, ok: false, body: undefined, text: "", error: error.message };
  }
};

// A segment the encoder has not written yet answers 503 SegmentNotReady: ask again until it comes.
const get = async (url) => {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (response.ok) return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
      const text = await response.text();
      if (response.status === 503 && Date.now() < deadline) {
        await sleep(500);
        continue;
      }
      return { status: response.status, text };
    } catch (error) {
      if (Date.now() >= deadline) return { status: 0, text: error.message };
      await sleep(500);
    }
  }
};

// Prints `seen <pid>` for each ffmpeg process on every poll, its arguments the first time, and its
// DRM fdinfo lines, until the stop file appears or the time runs out. Polls every 50 ms with shell
// builtins, since a GPU run can start and end within a few hundred. It runs as the media service's
// user, which may read that user's processes' fdinfo.
const WATCH = [
  'end=$(( $(date +%s) + $1 )); seen=" "',
  'while [ ! -e "$2" ] && [ "$(date +%s)" -lt "$end" ]; do',
  "  for d in /proc/[0-9]*; do",
  '    { read -r comm < "$d/comm"; } 2>/dev/null || continue',
  '    [ "$comm" = ffmpeg ] || continue',
  '    pid="${d#/proc/}"',
  '    echo "seen $pid"',
  '    case "$seen" in *" $pid "*) ;; *) seen="$seen$pid "; printf "args %s " "$pid"; tr "\\000" "\\037" < "$d/cmdline"; echo ;; esac',
  "    grep -sHE '^drm-(client-id|engine-[a-z-]+|cycles-[a-z]+):' \"$d\"/fdinfo/* | sed \"s|^$d/fdinfo/|gpu $pid |; s|:| |\"",
  "  done",
  "  sleep 0.05",
  "done",
].join("\n");

const startWatch = () => {
  const stop = `/tmp/verify-hardware-matrix-${process.pid}-${Date.now()}`;
  const child = spawn("docker", ["exec", "-u", `${flags.uid}:${flags.gid}`, flags.container, "sh", "-c", WATCH, "watch", "900", stop], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const closed = new Promise((resolve) => child.on("close", resolve));
  return {
    stop: async () => {
      // Two more polls first, so the last engine readings of a run still going are in.
      await sleep(500);
      docker(["exec", "-u", `${flags.uid}:${flags.gid}`, flags.container, "touch", stop]);
      await Promise.race([closed, sleep(5_000)]);
      child.kill();
      docker(["exec", "-u", `${flags.uid}:${flags.gid}`, flags.container, "rm", "-f", stop]);
      return output;
    },
  };
};

// ------------------------------------------------------------------------------------ fixtures

const nfo = (generate) =>
  [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    "<movie>",
    `  <title>${generate.title}</title>`,
    `  <year>${generate.year}</year>`,
    "  <plot>Generated by verify-media's hardware matrix.</plot>",
    "</movie>",
    "",
  ].join("\n");

const libraryCount = () => media("auth", "libraries", "list").page.length;

// Makes a generated fixture in the side's state, which `up` mounts at FIXTURE_ROOT, and scans it
// into its own library. Returns why it can't, or nothing.
const prepareGenerated = async (name, fixture) => {
  const mounts = JSON.parse(docker(["inspect", "-f", "{{json .Mounts}}", flags.container]).stdout || "[]");
  if (!mounts.some((mount) => mount.Destination === Matrix.FIXTURE_ROOT)) {
    return `fixture ${name} absent: the side has no ${Matrix.FIXTURE_ROOT}; run \`down --side ${flags.side}\` and \`up\` again`;
  }
  const { generate } = fixture;
  const folder = join(flags.state, "fixtures", `${generate.title} (${generate.year})`);
  const file = join(folder, generate.file);
  let made = false;
  if (!existsSync(file)) {
    mkdirSync(folder, { recursive: true });
    say(`generating ${name} with ${flags.image}'s ffmpeg`);
    const result = docker([
      "run",
      "--rm",
      "--name",
      `media-verify-${flags.run}-${flags.side}-fixture`,
      "--network",
      "none",
      "-u",
      `${flags.uid}:${flags.gid}`,
      "-v",
      `${folder}:/out`,
      "--entrypoint",
      "ffmpeg",
      flags.image,
      "-v",
      "error",
      "-nostdin",
      "-y",
      ...generate.args,
      "-f",
      generate.format ?? "matroska",
      `/out/${generate.file}.part`,
    ]);
    if (result.status !== 0) throw new Error(`generating ${name} failed: ${result.stderr.trim()}`);
    renameSync(`${file}.part`, file);
    writeFileSync(join(folder, "movie.nfo"), nfo(generate));
    for (const path of [join(flags.state, "fixtures"), folder, file, join(folder, "movie.nfo")]) {
      chmodSync(path, path === file || path.endsWith(".nfo") ? 0o644 : 0o755);
    }
    made = true;
  }
  const libraries = media("auth", "libraries", "list").page;
  const library = libraries.find((item) => item.name === Matrix.FIXTURE_LIBRARY);
  if (library === undefined) {
    say(`adding the ${Matrix.FIXTURE_LIBRARY} library over ${Matrix.FIXTURE_ROOT}`);
    media("admin", "libraries", "create", "--json", JSON.stringify({ name: Matrix.FIXTURE_LIBRARY, kind: "movies", folders: [Matrix.FIXTURE_ROOT] }));
  } else if (made) {
    media("auth", "libraries", "scan", "--library-id", library.libraryId);
  }
  if (library === undefined || made) {
    const seed = join(import.meta.dirname, "core-seed.mjs");
    const want = String(libraryCount());
    const waited = tool("node", [seed, "wait", "--state", flags.state, "--cli", flags.cli, "--container", flags.container, "--want", want], {
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 900_000,
    });
    if (waited.status !== 0) throw new Error(`the ${Matrix.FIXTURE_LIBRARY} scan did not finish`);
  }
  return undefined;
};

const resolved = new Map();

// The fixture's title and file on the side, and ffprobe's view of its source, or why it's absent.
const resolveFixture = async (name) => {
  if (resolved.has(name)) return resolved.get(name);
  const fixture = Matrix.FIXTURES[name];
  const path = Matrix.fixturePath(fixture);
  const found = await (async () => {
    if (fixture.generate) {
      const why = await prepareGenerated(name, fixture);
      if (why) return { skipped: why };
    }
    if (inContainer(["test", "-r", path]).status !== 0) return { skipped: `fixture ${name} absent: ${path} is not in the side` };
    const titleName = fixture.library?.title ?? fixture.generate.title;
    const title = media("movies", "titles", "search", "--query", titleName).find((item) => item.name === titleName);
    if (title === undefined) return { skipped: `fixture ${name} absent: no title "${titleName}" on the side` };
    const versions = media("movies", "titles", "versions", "--title-id", title.id);
    const version = fixture.library ? versions.find((item) => item.versionName === fixture.library.version) : versions[0];
    if (version === undefined) {
      return { skipped: `fixture ${name} absent: "${titleName}" has no version "${fixture.library.version}" (it has ${versions.map((item) => item.versionName).join(", ")})` };
    }
    const probe = inContainer(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path]);
    if (probe.status !== 0) throw new Error(`ffprobe could not read ${path}: ${probe.stderr.trim()}`);
    return { name, fixture, path, titleId: title.id, fileId: version.id, source: Matrix.parseProbe(probe.stdout) };
  })();
  resolved.set(name, found);
  return found;
};

// ------------------------------------------------------------------------------------- fetching

const generationOf = (url) => Number(/\/media\/hls\/[^/]+\/(\d+)\//.exec(url)?.[1]);

// The init segment and the segments that cover `span` seconds from `from`, written as one fMP4.
// When the service replaced the generation (a fallback), the fetch follows it and says so.
const fetchSpan = async (name, playlistUrl, from, span, dir, token) => {
  let url = playlistUrl;
  const notes = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const listed = await get(url);
    if (listed.status !== 200) return { name, ok: false, error: `the playlist answered ${listed.status} ${Matrix.redact(listed.text, token)}`, notes };
    const playlist = Matrix.parsePlaylist(listed.bytes.toString("utf8"), url);
    const wanted = Matrix.segmentsCovering(playlist.segments, from, span);
    if (playlist.init === undefined || wanted.length === 0) return { name, ok: false, error: `the playlist has no segments at ${from} s`, notes };
    const parts = [];
    let refused;
    for (const uri of [playlist.init, ...wanted.map((segment) => segment.uri)]) {
      const answer = await get(uri);
      if (answer.status !== 200) {
        refused = answer;
        break;
      }
      parts.push(answer.bytes);
    }
    if (refused === undefined) {
      const file = join(dir, `${name}.mp4`);
      writeFileSync(file, Buffer.concat(parts));
      return {
        name,
        ok: true,
        generation: generationOf(url),
        total: playlist.total,
        segments: wanted.map((segment, index) => ({ index: segment.index, start: segment.start, duration: segment.duration, bytes: parts[index + 1].length })),
        file,
        notes,
      };
    }
    let gone;
    try {
      gone = refused.status === 410 ? JSON.parse(refused.text).currentGeneration : undefined;
    } catch {
      gone = undefined;
    }
    if (gone === undefined) return { name, ok: false, error: `a segment answered ${refused.status} ${Matrix.redact(refused.text, token)}`, notes };
    notes.push(`generation ${generationOf(url)} was replaced by ${gone}`);
    url = url.replace(/\/(\d+)\/index\.m3u8/, `/${gone}/index.m3u8`);
  }
  return { name, ok: false, error: "the generation kept changing", notes };
};

// One stream's codec, sample rate, and packets (`{ pts, duration, dts }`, in seconds), read by
// ffprobe here or (`where`) in the side, within `interval` (`-read_intervals`) when given; or why
// it could not be read.
const streamPackets = (where, file, stream, interval) => {
  const probed = where([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    stream,
    ...(interval === undefined ? [] : ["-read_intervals", interval]),
    "-show_entries",
    "stream=codec_name,sample_rate:packet=pts_time,dts_time,duration_time",
    "-of",
    "json",
    file,
  ]);
  if (probed.status !== 0) return { error: `ffprobe exited ${probed.status}: ${probed.stderr.trim().split("\n")[0]}` };
  const parsed = JSON.parse(probed.stdout);
  const [info] = parsed.streams ?? [];
  const time = (value) => (value === undefined || value === "N/A" ? undefined : Number(value));
  return {
    codec: info?.codec_name,
    sampleRate: info?.sample_rate,
    packets: (parsed.packets ?? []).map((packet) => ({ pts: time(packet.pts_time), dts: time(packet.dts_time), duration: time(packet.duration_time) })),
  };
};

const here = (args) => tool(args[0], args.slice(1));
const inSide = (args) => inContainer(args);

// ffprobe's and ffmpeg's view of a fetched span: the video stream, its frames, decode errors, when
// its sound starts, and whose fingerprint the bytes carry.
const readFetch = (fetch, dir) => {
  if (!fetch.ok) return fetch;
  const streams = tool("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", fetch.file]);
  writeFileSync(join(dir, `${fetch.name}.ffprobe.json`), streams.stdout);
  const frames = tool("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "frame=pts_time,best_effort_timestamp_time,key_frame,interlaced_frame",
    "-of",
    "json",
    fetch.file,
  ]);
  writeFileSync(join(dir, `${fetch.name}.frames.json`), frames.stdout);
  const decoded = tool("ffmpeg", ["-v", "error", "-nostdin", "-i", fetch.file, "-map", "0:v:0", "-f", "null", "-"]);
  const audio = streamPackets(here, fetch.file, "a:0");
  const video = streamPackets(here, fetch.file, "v:0");
  const decodes = (video.packets ?? []).map((packet) => packet.dts).filter(Number.isFinite);
  const sounds = (audio.packets ?? []).map((packet) => packet.pts).filter(Number.isFinite);
  return {
    ...fetch,
    audio: sounds.length === 0 ? undefined : { start: Math.min(...sounds), codec: audio.codec, sampleRate: audio.sampleRate },
    firstDecoded: decodes.length === 0 ? undefined : Math.min(...decodes),
    media: streams.status === 0 ? Matrix.parseProbe(streams.stdout) : undefined,
    frames: frames.status === 0 ? Matrix.parseFrames(frames.stdout) : [],
    decodeErrors: decoded.status === 0 ? decoded.stderr : `${decoded.stderr}\nffmpeg exited ${decoded.status}`,
    fingerprint: Matrix.fingerprint(readFileSync(fetch.file)),
  };
};

// ------------------------------------------------------------------------------------- analyses

const idetOf = (result) => Matrix.parseIdet(`${result.stdout}\n${result.stderr}`);

const spanOf = (fetch) => ({ from: fetch.segments[0].start, seconds: fetch.segments.reduce((sum, segment) => sum + segment.duration, 0) });

const analyseProgressive = (obs, found, dir) => {
  const fetch = obs.fetches.seek;
  if (!fetch?.ok) return undefined;
  const { from, seconds } = spanOf(fetch);
  const output = tool("ffmpeg", ["-hide_banner", "-nostats", "-nostdin", "-i", fetch.file, "-map", "0:v:0", "-vf", "idet", "-f", "null", "-"]);
  const span = ["-ss", String(from), "-t", String(seconds), "-i", found.path];
  const source = inContainer(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", ...span, "-map", "0:v:0", "-vf", "idet", "-f", "null", "-"]);
  writeFileSync(join(dir, "idet.txt"), `output:\n${output.stderr}\nsource ${from}-${from + seconds} s:\n${source.stderr}\n`);
  return { output: idetOf(output), source: idetOf(source) };
};

const analysePicture = (obs, found, params, dir) => {
  const fetch = obs.fetches.seek;
  if (!fetch?.ok) return undefined;
  const until = params.at + params.seconds;
  const output = tool("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-copyts",
    "-i",
    fetch.file,
    "-map",
    "0:v:0",
    "-vf",
    `select='between(t\\,${params.at}\\,${until - 0.001})',${Matrix.PRINT_STATS}`,
    "-f",
    "null",
    "-",
  ]);
  const reference = inContainer([
    "ffmpeg",
    "-v",
    "error",
    "-nostdin",
    "-ss",
    String(params.at),
    "-t",
    String(params.seconds),
    "-i",
    found.path,
    "-map",
    "0:v:0",
    "-vf",
    `${Matrix.REFERENCE_TONE_MAP},${Matrix.PRINT_STATS}`,
    "-f",
    "null",
    "-",
  ]);
  writeFileSync(join(dir, "picture.txt"), `output:\n${output.stdout}${output.stderr}\nreference:\n${reference.stdout}${reference.stderr}`);
  frameAt(fetch.file, params.at, join(dir, `output-${params.at}.png`));
  return { output: Matrix.parseSignalstats(output.stdout), reference: Matrix.parseSignalstats(reference.stdout) };
};

// Gray thumbnails of `args`' picture with their times, from a run here or (`where`) in the side,
// or why they could not be made.
const thumbnails = (where, args) => {
  const run = where([...args, "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "rawvideo", "-"], { encoding: "buffer" });
  const log = run.stderr?.toString() ?? "";
  if (run.status !== 0) return { frames: [], error: `ffmpeg exited ${run.status ?? run.signal}: ${log.trim().split("\n").at(-1) ?? ""}` };
  return { frames: Matrix.parseThumbnails(run.stdout, log) };
};

// Each fetch's frames against the source's picture for their times: thumbnails of the output, and
// of the source from the search window before the span to the window after it on its own
// timeline, through the reference tone map where the row maps HDR to SDR, judged frame by frame
// within a frame of the source's rate. Thumbnails that could not be made leave the fetch unjudged.
const analyseTiming = (obs, found, cell, dir) => {
  const timing = {};
  const lines = [];
  const spec = Matrix.COMMON_CHECKS.find((check) => check.check === "picture-time");
  const rate = found.source?.baseFps ?? found.source?.fps;
  const toneMap = cell.row.work["tone-map"] === undefined ? "" : `scale=384:-2,${Matrix.REFERENCE_TONE_MAP},`;
  for (const fetch of [obs.fetches.start, obs.fetches.seek]) {
    if (!fetch?.ok) continue;
    const { from, seconds } = spanOf(fetch);
    const begin = Math.max(0, from - Matrix.TIMING_WINDOW - 1);
    const output = thumbnails((args, options) => tool("ffmpeg", args, options), [
      "-hide_banner",
      "-nostdin",
      "-copyts",
      "-i",
      fetch.file,
      "-vf",
      Matrix.THUMBNAIL.filter,
    ]);
    const source = thumbnails((args, options) => inContainer(["ffmpeg", ...args], options), [
      "-hide_banner",
      "-nostdin",
      "-ss",
      String(begin),
      "-copyts",
      "-t",
      String(from + seconds + Matrix.TIMING_WINDOW + 1 - begin),
      "-i",
      found.path,
      "-vf",
      `${toneMap}${Matrix.THUMBNAIL.filter}`,
    ]);
    const error = output.error ?? source.error ?? (rate > 0 ? undefined : "the source has no frame rate");
    const judged = Matrix.judgeFrames(output.frames, source.frames, {
      window: Matrix.TIMING_WINDOW,
      allowance: spec.frames / rate,
      minMatch: spec.minMatch,
      tolerance: spec.tolerance,
      quiet: spec.quiet,
    });
    timing[fetch.name] = { ...Matrix.frameTiming(judged), ...(error === undefined ? {} : { error }) };
    lines.push(
      `${fetch.name}: ${output.frames.length} output thumbnails, ${source.frames.length} source thumbnails from ${begin} s${error ? ` (${error})` : ""}: ${JSON.stringify(timing[fetch.name])}`,
      ...judged.failed.slice(0, 20).map((frame) => `  ${JSON.stringify(frame)}`),
    );
  }
  writeFileSync(join(dir, "timing.txt"), `${lines.join("\n")}\n`);
  return timing;
};

// The source's audio track that negotiation chose, around where each fetch starts: the packets from
// two seconds before its first decoded video packet to two after its first picture.
const analyseSourceAudio = (obs, found) => {
  const index = obs.negotiation?.body?.audio?.streamIndex;
  if (index === undefined) return;
  for (const fetch of [obs.fetches.start, obs.fetches.seek]) {
    if (!fetch?.ok || fetch.frames?.[0] === undefined) continue;
    const from = Math.max(0, Math.min(fetch.firstDecoded ?? fetch.frames[0].pts, fetch.frames[0].pts) - 2);
    fetch.sourceAudio = streamPackets(inSide, found.path, String(index), `${from}%${fetch.frames[0].pts + 2}`);
  }
};

// The output keeps the source's timeline, which ffmpeg moves to zero unless told to copy it.
const frameAt = (file, at, png) =>
  tool("ffmpeg", ["-v", "error", "-nostdin", "-y", "-copyts", "-i", file, "-map", "0:v:0", "-vf", `select='gte(t\\,${at})'`, "-fps_mode", "passthrough", "-frames:v", "1", png]);

// The share of pixels that differ by more than 40 levels between two pictures inside `crop`.
const changed = (a, b, crop, png) => {
  const graph = `[0:v]format=gray[a];[1:v]format=gray[b];[a][b]blend=all_mode=difference,lut=y='if(gt(val,40),255,0)'`;
  if (png) tool("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", a, "-i", b, "-filter_complex", graph, "-frames:v", "1", png]);
  const result = tool("ffmpeg", ["-v", "error", "-nostdin", "-i", a, "-i", b, "-filter_complex", `${graph},crop=${crop},${Matrix.PRINT_STATS}`, "-f", "null", "-"]);
  const stats = Matrix.parseSignalstats(result.stdout);
  return stats === undefined ? undefined : stats.YAVG / 255;
};

const analyseBurn = (obs, found, params, dir) => {
  const fetch = obs.fetches.seek;
  if (!fetch?.ok || fetch.media === undefined) return undefined;
  const { width, height } = fetch.media;
  const band = `iw:ih*${(1 - params.band).toFixed(2)}:0:ih*${params.band}`;
  const elsewhere = `iw:ih*${(params.band - 0.1).toFixed(2)}:0:0`;
  const compare = (at) => {
    const output = join(dir, `output-${at}.png`);
    const reference = join(dir, `source-${at}.png`);
    frameAt(fetch.file, at, output);
    const picture = ["-map", "0:v:0", "-frames:v", "1", "-vf", `scale=${width}:${height}`, "-f", "image2pipe", "-c:v", "png", "-"];
    const source = inContainer(["ffmpeg", "-v", "error", "-nostdin", "-ss", String(at), "-i", found.path, ...picture], {
      encoding: "buffer",
    });
    writeFileSync(reference, source.stdout);
    if (!existsSync(output) || source.status !== 0) return undefined;
    return { band: changed(output, reference, band, join(dir, `changed-${at}.png`)), elsewhere: changed(output, reference, elsewhere) };
  };
  return { shown: compare(params.shownAt), hidden: compare(params.hiddenAt) };
};

// --------------------------------------------------------------------------------------- a cell

const measure = async (cell, found, health, dir) => {
  const { row } = cell;
  const profile = Matrix.PROFILES[row.profile].capabilities;
  const obs = { fetches: {}, health };
  const started = media("movies", "play", "start", "--json", JSON.stringify({ titleId: found.titleId, fileId: found.fileId, capabilities: profile }));
  const token = started.ticket;
  const since = new Date(Date.now() - 2_000).toISOString();
  const watch = startWatch();
  let streamId;
  try {
    const negotiation = await post("/api/playback/negotiate", { token, capabilities: profile, startSeconds: row.start, ...row.request });
    obs.negotiation = { status: negotiation.status, ok: negotiation.ok, body: negotiation.body, error: negotiation.error };
    const exchange = {
      request: { capabilities: profile, startSeconds: row.start, ...row.request },
      status: negotiation.status,
      answer: negotiation.body ?? negotiation.text,
    };
    writeFileSync(join(dir, "negotiate.json"), Matrix.redact(JSON.stringify(exchange, null, 2), token));
    if (negotiation.ok && negotiation.body.streamId !== undefined) {
      streamId = negotiation.body.streamId;
      obs.fetches.start = await fetchSpan("start", negotiation.body.url, row.start, row.span, dir, token);
      const seek = await post("/api/playback/seek", { token, streamId, positionSeconds: row.seek });
      obs.fetches.seek = seek.ok
        ? await fetchSpan("seek", seek.body.playlistUrl, row.seek, row.span, dir, token)
        : { name: "seek", ok: false, error: `the seek answered ${seek.status} ${Matrix.redact(seek.text, token)}` };
    }
  } finally {
    if (streamId !== undefined) await post("/api/playback/stop", { token, streamId });
    const watched = await watch.stop();
    writeFileSync(join(dir, "ffmpeg-watch.txt"), watched);
    obs.runs = streamId === undefined ? [] : Matrix.streamRuns(Matrix.parseWatch(watched), streamId);
  }
  const logs = docker(["logs", "--since", since, flags.container]);
  obs.log = Matrix.sessionRecords(`${logs.stdout}\n${logs.stderr}`, started.playbackId);
  writeFileSync(join(dir, "service-log.jsonl"), Matrix.redact(obs.log.map((record) => JSON.stringify(record)).join("\n"), token));
  obs.fetches.start = obs.fetches.start && readFetch(obs.fetches.start, dir);
  obs.fetches.seek = obs.fetches.seek && readFetch(obs.fetches.seek, dir);
  obs.source = found.source;
  analyseSourceAudio(obs, found);
  obs.analysis = { timing: analyseTiming(obs, found, cell, dir) };
  for (const spec of row.checks) {
    if (spec.check === "progressive") obs.analysis.idet = analyseProgressive(obs, found, dir);
    if (spec.check === "picture") obs.analysis.picture = analysePicture(obs, found, spec, dir);
    if (spec.check === "burned-in") obs.analysis.burn = analyseBurn(obs, found, spec, dir);
  }
  return obs;
};

// What a cell keeps of its observations, beside its verdict: no bytes, no tickets.
const summary = (obs) => ({
  health: obs.health,
  negotiation: obs.negotiation && {
    status: obs.negotiation.status,
    mode: obs.negotiation.body?.mode,
    video: obs.negotiation.body?.video,
    refused: obs.negotiation.ok ? undefined : obs.negotiation.body,
  },
  source: obs.source,
  fetches: Object.fromEntries(
    Object.entries(obs.fetches ?? {}).map(([name, fetch]) => [
      name,
      fetch && {
        ok: fetch.ok,
        error: fetch.error,
        notes: fetch.notes,
        generation: fetch.generation,
        segments: fetch.segments,
        media: fetch.media,
        frames: fetch.frames?.length,
        fps: fetch.frames && Matrix.measuredFps(fetch.frames),
        fingerprint: fetch.fingerprint,
        audio: fetch.audio,
        firstDecoded: fetch.firstDecoded,
        sourceAudio: fetch.sourceAudio && { ...fetch.sourceAudio, packets: fetch.sourceAudio.packets?.slice(0, 8) },
        decodeErrors: fetch.decodeErrors?.trim() || undefined,
      },
    ]),
  ),
  runs: (obs.runs ?? []).map((run) => ({ pid: run.pid, where: Matrix.describeRun(run), engines: run.engines, args: run.args })),
  log: (obs.log ?? []).map((record) => ({ message: record.message, ...record.annotations })),
  analysis: obs.analysis,
});

const writeCell = (cell, result, obs, extra) => {
  const dir = cellDir(cell);
  mkdirSync(dir, { recursive: true });
  const record = {
    side: flags.side,
    stage: cell.row.stage,
    row: cell.row.id,
    path: cell.path,
    verdict: result.verdict,
    evidence: result.evidence,
    measured: new Date().toISOString(),
    image: flags.image,
    cell: relative(flags.out, dir),
    ...extra,
    checks: result.checks,
    observations: obs && summary(obs),
  };
  writeFileSync(join(dir, "cell.json"), `${Matrix.redact(JSON.stringify(record, null, 2))}\n`);
  say(`${cell.row.id} on ${cell.path}: ${result.verdict}: ${result.evidence}`);
};

const cellDir = (cell) => join(flags.out, flags.side, cell.path, cell.row.id);

// ----------------------------------------------------------------------------------------- grid

const writeGrid = () => {
  const results = [];
  for (const side of ["after", "before"]) {
    for (const path of Object.keys(Matrix.PATHS)) {
      for (const row of Matrix.ROWS) {
        const file = join(flags.out, side, path, row.id, "cell.json");
        if (!existsSync(file)) continue;
        const { checks: _checks, observations: _observations, ...kept } = JSON.parse(readFileSync(file, "utf8"));
        results.push(kept);
      }
    }
  }
  const grid = Matrix.renderGrid(results, { run: flags.run });
  writeFileSync(join(flags.out, "grid.tsv"), grid.tsv);
  writeFileSync(join(flags.out, "grid.md"), grid.md);
  writeFileSync(join(flags.out, "grid.json"), grid.json);
  process.stdout.write(grid.md);
  say(`wrote ${join(flags.out, "grid.md")}, grid.tsv, and grid.json`);
};

// ----------------------------------------------------------------------------------------- main

// /api/health, asked a few times: the first answers after a restart can drop.
const readHealth = async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${flags.url}/api/health`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) return await response.json();
    } catch {
      // Asked again below.
    }
    await sleep(2_000);
  }
  return undefined;
};

const renderNode = () => existsSync("/dev/dri") && readdirSync("/dev/dri").some((name) => name.startsWith("renderD"));

const main = async () => {
  mkdirSync(flags.out, { recursive: true });
  if (flags["grid-only"]) return writeGrid();
  const paths = flags.paths.split(",").filter(Boolean);
  for (const path of paths) if (!(path in Matrix.PATHS)) fail(`--paths takes ${Object.keys(Matrix.PATHS).join(", ")}, not ${path}`);
  const wanted = flags.rows?.split(",").filter(Boolean);
  for (const id of wanted ?? []) if (!Matrix.ROWS.some((row) => row.id === id)) fail(`no row ${id}; rows: ${Matrix.ROWS.map((row) => row.id).join(", ")}`);
  const all = Matrix.cells().filter((cell) => paths.includes(cell.path) && (wanted === undefined || wanted.includes(cell.row.id)));

  for (const path of paths) {
    const mine = all.filter((cell) => cell.path === path);
    if (mine.length === 0) continue;
    const { setting, device } = Matrix.PATHS[path];
    if (device && !renderNode()) {
      for (const cell of mine) writeCell(cell, { verdict: "SKIPPED", evidence: "no GPU render node (/dev/dri/renderD*) on this host", checks: [] });
      continue;
    }
    say(`switching the ${flags.side} side to HARDWARE_ACCELERATION=${setting}`);
    const switched = spawnSync("bash", [flags.helper, "hardware", "--side", flags.side, setting], { stdio: ["ignore", 2, 2], timeout: 900_000 });
    if (switched.status !== 0) {
      for (const cell of mine) writeCell(cell, { verdict: "FAIL", evidence: `the side did not come back with HARDWARE_ACCELERATION=${setting}`, checks: [] });
      continue;
    }
    const health = await readHealth();
    say(`the media service reports hardwareAcceleration=${health?.hardwareAcceleration}`);
    for (const cell of mine) {
      const dir = cellDir(cell);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      let found;
      try {
        found = await resolveFixture(cell.row.fixture);
      } catch (error) {
        writeCell(cell, { verdict: "FAIL", evidence: `the fixture could not be prepared: ${error.message}`, checks: [] });
        continue;
      }
      if (found.skipped) {
        writeCell(cell, { verdict: "SKIPPED", evidence: found.skipped, checks: [] });
        continue;
      }
      let obs;
      try {
        obs = await measure(cell, found, health, dir);
      } catch (error) {
        writeCell(cell, { verdict: "FAIL", evidence: `the harness could not measure the cell: ${error.message}`, checks: [] }, obs);
        continue;
      }
      writeCell(cell, Matrix.judge(cell, obs), obs, { hardwareAcceleration: health?.hardwareAcceleration });
    }
  }
  writeGrid();
};

await main();
