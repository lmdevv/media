// Checks the app's frame marks against the screen recording `ios timings --record` made of the same
// run, without the launch's zero: the process start, which no recording can show.
//
//   node app-timings-truth.mjs sheets <app-timings-dir>
//   node app-timings-truth.mjs judge <app-timings-dir> [frame-ms]
//   node app-timings-truth.mjs frames <truth.mp4> <out.png> <seconds>...
//
// Within one launch, the app's own clock gives the time from Home's content mark to the first
// open's content mark (marks.ndjson: each mark the app's `LaunchClock` wrote to the device's log,
// by process), and the recording gives the time between the same two frames. The two differences
// share no zero point, so they agree within two frames exactly when both marks land on the frames
// the screen showed.
//
// `sheets` cuts, from truth.mp4, a storyboard of each launch and each press in actions.tsv: every
// frame that visibly changed, captioned with its time in the recording. Read the frames yourself
// and write truth.tsv in the same folder, one tab-separated row per launch with a header:
//
//   launch  home_s  open_s
//
// `home_s` is the recording's time (the sheets' caption) of the first frame showing Home's content
// (its rows and titles, not their artwork); `open_s` of the first frame showing the first opened
// screen's content. `frames` cuts a small sheet of the frames at the given times, to look closer.
// `judge` prints, per launch, both differences, how far apart they are, and whether every launch
// agrees within two frames.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The recording, scaled down this many times, is what the change finder compares. */
const SCALE = 9;

const WIDTH = Math.round(1206 / SCALE);

const HEIGHT = Math.round(2622 / SCALE);

/** Mean grey-level change over a cell of the screen that counts as the screen changing there. */
const CHANGED = 4;

/** Each line of actions.tsv: the wall clock in milliseconds, what the probe did, and its detail. */
export const parseActions = (text) =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [ms, kind, detail = ""] = line.split("\t");

      return { ms: Number(ms), kind, detail };
    });

/** The frames of `video` from `from` to `to` seconds, each its time and its grey pixels. */
const framesBetween = (video, from, to) => {
  const decoded = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-copyts",
      "-ss",
      String(Math.max(0, from)),
      "-to",
      String(to),
      "-i",
      video,
      "-vf",
      `scale=${String(WIDTH)}:${String(HEIGHT)},format=gray,showinfo`,
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: 1 << 30 },
  );
  const times = [...decoded.stderr.toString().matchAll(/pts_time:([\d.]+)/gu)].map((match) =>
    Number(match[1]),
  );
  const size = WIDTH * HEIGHT;

  return times.map((t, index) => ({ t, pixels: decoded.stdout.subarray(index * size, (index + 1) * size) }));
};

/** The mean grey-level difference of two frames inside a box of the scaled frame. */
const difference = (left, right, box = { x: 0, y: 0, w: WIDTH, h: HEIGHT }) => {
  let total = 0;

  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      total += Math.abs(left[y * WIDTH + x] - right[y * WIDTH + x]);
    }
  }

  return total / (box.w * box.h);
};

/**
 * The frames of `frames` that each differ from the last one kept by more than `CHANGED` grey
 * levels anywhere in a cell of the screen: a storyboard of what changed, at most `max` frames.
 */
const storyboard = (frames, max) => {
  const kept = [];
  let last = null;

  for (const frame of frames) {
    if (last === null || changedCell(frame.pixels, last.pixels)) {
      kept.push(frame);
      last = frame;
    }

    if (kept.length >= max) break;
  }

  return kept;
};

/**
 * Whether any cell of a 6 by 12 grid changed by more than `CHANGED` grey levels on average. The top
 * row, with the status bar and the dev client's loading banner, doesn't count.
 */
const changedCell = (left, right) => {
  const w = Math.floor(WIDTH / 6);
  const h = Math.floor(HEIGHT / 12);

  for (let row = 1; row < 12; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      if (difference(left, right, { x: column * w, y: row * h, w, h }) > CHANGED) return true;
    }
  }

  return false;
};

/** Writes a captioned sheet of `video`'s frames at `times` to `path`, each `width` pixels wide. */
const sheet = (video, times, path, width = 201) => {
  if (times.length === 0) return;
  const from = Math.max(0, times[0] - 0.05);
  const to = times.at(-1) + 0.05;
  const pick = times.map((t) => `between(t\\,${(t - 0.001).toFixed(4)}\\,${(t + 0.001).toFixed(4)})`).join("+");
  const columns = Math.min(times.length, 10);
  const rows = Math.ceil(times.length / columns);

  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-copyts",
    "-ss",
    String(from),
    "-to",
    String(to),
    "-i",
    video,
    "-vf",
    `select='${pick}',scale=${String(width)}:-2,drawtext=text='%{pts\\:flt}':x=4:y=4:fontsize=${String(Math.round(width / 11))}:fontcolor=yellow:box=1:boxcolor=black,tile=${String(columns)}x${String(rows)}`,
    "-fps_mode",
    "passthrough",
    "-frames:v",
    "1",
    path,
  ]);
};

/** A storyboard sheet of each launch and press of one `ios timings --record` run. */
const sheets = (dir) => {
  const video = join(dir, "truth.mp4");
  const actions = parseActions(readFileSync(join(dir, "actions.tsv"), "utf8"));
  const recordStart = actions.find((action) => action.kind === "record-start")?.ms ?? actions[0].ms;
  const out = join(dir, "truth");
  const lines = [];

  mkdirSync(out, { recursive: true });

  actions.forEach((action, number) => {
    const at = (action.ms - recordStart) / 1000;
    const span = { launch: [-0.5, 14], press: [-0.3, 1.5] }[action.kind];

    if (span === undefined) return;
    const frames = storyboard(framesBetween(video, at + span[0], at + span[1]), 50);
    const name = `${String(number).padStart(3, "0")}-${action.kind}-${action.detail.split("|")[0].replaceAll(/[^\w]+/gu, "-")}`;

    sheet(video, frames.map((frame) => frame.t), join(out, `${name}.png`));
    lines.push(`${name}\t${frames.map((frame) => frame.t.toFixed(3)).join(" ")}`);
  });

  writeFileSync(join(out, "storyboards.tsv"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
};

const MARK = /^(home-screen|home-content|open) drawn at ([\d.]+) hitched (true|false)(?: |$)/u;

/**
 * The frame marks in the device's log (`log show --style ndjson`), grouped by process in the order
 * the processes first wrote one: one group per launch, each mark its name, its refresh's time in
 * milliseconds on the app's clock, and whether that refresh was hitched.
 */
export const parseMarks = (text) => {
  const launches = new Map();

  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    const entry = JSON.parse(line);
    const mark = MARK.exec(entry.eventMessage ?? "");

    if (mark === null) continue;
    const marks = launches.get(entry.processID) ?? [];

    marks.push({ name: mark[1], at: Number(mark[2]), hitched: mark[3] === "true" });
    launches.set(entry.processID, marks);
  }

  return [...launches.values()];
};

/**
 * Per launch of `truth` (`launch`, `home_s`, `open_s`), the app's time from Home's content mark
 * (its screen mark when Home drew no content mark) to the first open's mark, the recording's time
 * between the same frames, the difference, and whether it is within two frames.
 */
export const judge = (launches, truth, frameMs) =>
  truth.map((row) => {
    const marks = launches[row.launch - 1] ?? [];
    const home =
      marks.find((mark) => mark.name === "home-content") ??
      marks.find((mark) => mark.name === "home-screen");
    const open = marks.find((mark) => mark.name === "open");
    const recordedMs = (row.open_s - row.home_s) * 1000;

    if (home === undefined || open === undefined) {
      return { launch: row.launch, appMs: null, recordedMs, difference: null, agrees: false, hitched: [] };
    }

    const appMs = open.at - home.at;
    const difference = appMs - recordedMs;

    return {
      launch: row.launch,
      appMs,
      recordedMs,
      difference,
      agrees: Math.abs(difference) <= 2 * frameMs,
      hitched: [home, open].filter((mark) => mark.hitched).map((mark) => mark.name),
    };
  });

const parseTruth = (text) => {
  const [header, ...lines] = text.split("\n").filter((line) => line.trim().length > 0);
  const names = header.split("\t");

  return lines.map((line) => {
    const cells = line.split("\t");

    return Object.fromEntries(
      names.map((name, index) => [name, name === "sample" ? cells[index] : Number(cells[index])]),
    );
  });
};

const round = (value) => (value === null ? "–" : String(Math.round(value)));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, target, frame] = process.argv.slice(2);

  if (command === "sheets" && target !== undefined) {
    sheets(target);
  } else if (command === "frames" && target !== undefined && frame !== undefined) {
    sheet(target, process.argv.slice(5).map(Number), frame, 134);
  } else if (command === "judge" && target !== undefined) {
    const frameMs = Number(frame ?? 1000 / 60);
    const launches = parseMarks(readFileSync(join(target, "marks.ndjson"), "utf8"));
    const rows = judge(launches, parseTruth(readFileSync(join(target, "truth.tsv"), "utf8")), frameMs);

    console.log("| launch | app clock, Home → open ms | recording, Home → open ms | difference ms | hitched marks |");
    console.log("| --: | --: | --: | --: | --- |");

    for (const row of rows) {
      console.log(
        `| ${String(row.launch)} | ${round(row.appMs)} | ${round(row.recordedMs)} | ${round(row.difference)} | ${row.hitched.join(", ") || "none"} |`,
      );
    }

    const agree = rows.filter((row) => row.agrees).length;

    console.log(
      `\n${String(agree)} of ${String(rows.length)} launches agree within two frames (${round(2 * frameMs)} ms); ${rows.every((row) => row.agrees) ? "the marks land on the frames the screen showed" : "DISAGREES"}.`,
    );
  } else {
    console.error(
      "usage: node app-timings-truth.mjs sheets <app-timings-dir> | judge <app-timings-dir> [frame-ms] | frames <truth.mp4> <out.png> <seconds>...",
    );
    process.exit(2);
  }
}
