// Checks each timing an app logged against the screen recording `ios timings --record` made of the
// same run.
//
//   node app-timings-truth.mjs sheets <app-timings-dir>
//   node app-timings-truth.mjs judge <truth.tsv> [frame-ms]
//
// `sheets` cuts, from truth.mp4, a storyboard of each launch and each press in actions.tsv: every
// frame that visibly changed, captioned with its time in the recording. Read the frames yourself
// and write truth.tsv, one tab-separated row per sample with a header:
//
//   sample  logged_ms  zero_s  end_s
//
// `zero_s` and `end_s` are the recording's times (the sheets' captions) of the sample's zero and
// end frames: for a launch, iOS's launch animation starting and the frame the metric names; for an
// open, the pressed control's feedback clearing and the opened screen's content first in view.
// `judge` prints each sample's recorded span, how far the logged value is from it, and whether all
// agree within two frames once the zero points' median difference is taken out.

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

/** Writes a captioned sheet of `video`'s frames at `times` to `path`. */
const sheet = (video, times, path) => {
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
    `select='${pick}',scale=201:437,drawtext=text='%{pts\\:flt}':x=4:y=4:fontsize=18:fontcolor=yellow:box=1:boxcolor=black,tile=${String(columns)}x${String(rows)}`,
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

/** The median of `values`. */
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = (sorted.length - 1) / 2;

  return (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2;
};

/**
 * Each sample's recorded span, the logged value's distance from it, and, once the median distance
 * (the zero points' difference) is taken out, whether every sample agrees within two frames.
 */
export const judge = (rows, frameMs) => {
  const samples = rows.map((row) => {
    const recordedMs = (row.end_s - row.zero_s) * 1000;

    return { ...row, recordedMs, distance: row.logged_ms - recordedMs };
  });
  const groups = Map.groupBy(samples, (sample) => sample.sample.replace(/-\d+$/u, ""));

  return [...groups].map(([metric, group]) => {
    const offset = median(group.map((sample) => sample.distance));

    return {
      metric,
      offset,
      samples: group.map((sample) => ({ ...sample, residual: sample.distance - offset })),
      agrees: group.every((sample) => Math.abs(sample.distance - offset) <= 2 * frameMs),
    };
  });
};

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

const round = (value) => String(Math.round(value));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, target, frame] = process.argv.slice(2);

  if (command === "sheets" && target !== undefined) {
    sheets(target);
  } else if (command === "judge" && target !== undefined) {
    const frameMs = Number(frame ?? 1000 / 60);
    const metrics = judge(parseTruth(readFileSync(target, "utf8")), frameMs);

    console.log("| sample | logged ms | recorded ms | logged − recorded | after the zero offset |");
    console.log("| --- | --: | --: | --: | --: |");

    for (const metric of metrics) {
      for (const sample of metric.samples) {
        console.log(
          `| ${sample.sample} | ${round(sample.logged_ms)} | ${round(sample.recordedMs)} | ${round(sample.distance)} | ${round(sample.residual)} |`,
        );
      }
    }

    console.log("");

    for (const metric of metrics) {
      console.log(
        `${metric.metric}: zero offset ${round(metric.offset)} ms; ${metric.agrees ? "agrees" : "DISAGREES"} within two frames (${round(2 * frameMs)} ms)`,
      );
    }
  } else {
    console.error("usage: node app-timings-truth.mjs sheets <app-timings-dir> | judge <truth.tsv> [frame-ms]");
    process.exit(2);
  }
}
