// Checks the app's frame marks against the screen recording `ios timings --record` made of the same
// run, without the launch's zero: the process start, which no recording can show.
//
//   node app-timings-truth.mjs sheets <app-timings-dir>
//   node app-timings-truth.mjs settle <app-timings-dir>
//   node app-timings-truth.mjs judge <app-timings-dir> [frame-ms]
//   node app-timings-truth.mjs frames <truth.mp4> <out.png> <seconds>...
//
// Each mark has two ends: content ready (committed and laid out, wherever it stands) and content
// at rest (in place with any slide-in over). Within one launch, the app's own clock gives the time
// from Home's content mark at rest to each open's mark at rest (marks.ndjson: each mark the app's
// `LaunchClock` wrote to the device's log, by process), and the recording gives the time between
// the same two frames. The two differences share no zero point; a mark that tracks the screen
// keeps them within `AGREE_FRAMES` frames, and steady from open to open of one screen and cache
// state. Content ready has no frame to compare with during a slide, so `judge` checks it against
// the log instead: never after rest, and a frame or two after the commit that mounted it.
//
// `sheets` cuts, from truth.mp4, a storyboard of each launch and each press in actions.tsv: every
// frame that visibly changed, captioned with its time in the recording. `settle` finds, for each
// press, the first frame from which the opened screen stands where it rests: it lines each frame
// up with the screen's last frame before the next action by the columns of its edges, and
// prints the frame from which the two line up within a pixel (`rest_s`). Write truth.tsv in the
// same folder, one tab-separated row per open with a header:
//
//   launch  open  home_s  open_s
//
// `open` counts the launch's opens from 1, in the order of its presses. `home_s` is the
// recording's time (the sheets' caption) of the first frame showing Home's content (its rows and
// titles, not their artwork); `open_s` of the first frame showing that open's content at rest:
// `rest_s` when the content was there before the screen came to rest, as a kept open's is,
// otherwise the first frame showing the content. `frames` cuts a small sheet of the frames at the
// given times, to look closer. `judge` prints, per open, both differences and how far apart they
// are, whether every open with no hitched mark agrees, the spread per screen and cache state, and
// the ready check (it reads records.ndjson for each open's screen, cache, and ready time).

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

/** The frames of `video` from `from` to `to` seconds, each its time and its grey pixels, at a size. */
const framesSized = (video, from, to, width, height) => {
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
      `scale=${String(width)}:${String(height)},format=gray,showinfo`,
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: 2 ** 31 },
  );
  const times = [...decoded.stderr.toString().matchAll(/pts_time:([\d.]+)/gu)].map((match) =>
    Number(match[1]),
  );
  const size = width * height;

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

/** The recording's size in pixels. */
const sizeOf = (video) => {
  const [width, height] = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", video],
    { encoding: "utf8" },
  )
    .trim()
    .split(",")
    .map(Number);

  return { width, height };
};

/** The rows of the screen `settle` lines up: below the status bar, above a tab bar and player. */
const BAND = { from: 0.08, to: 0.75 };

/**
 * How strongly each column of a grey frame `width` pixels wide changes from the column to its
 * right, summed over `BAND`'s rows: where the screen's edges stand across it.
 */
export const edgeColumns = (pixels, width, height) => {
  const columns = new Float64Array(width);

  for (let y = Math.floor(height * BAND.from); y < Math.floor(height * BAND.to); y += 1) {
    const row = y * width;

    for (let x = 0; x < width - 1; x += 1) columns[x] += Math.abs(pixels[row + x + 1] - pixels[row + x]);
  }

  return columns;
};

/**
 * How far right, in pixels, `columns` shows what `resting` shows, from `-slack` to `maxShift`, and
 * how well the two line up there (their correlation, 1 for a perfect match), over at least
 * `overlap` shared columns.
 */
export const shiftOf = (columns, resting, { maxShift, slack = 8, overlap = 160 }) => {
  let best = { shift: 0, match: -Infinity };

  for (let shift = -slack; shift <= maxShift; shift += 1) {
    const from = Math.max(0, shift);
    const to = Math.min(columns.length, resting.length + shift);

    if (to - from < overlap) break;
    let product = 0;
    let own = 0;
    let theirs = 0;

    for (let x = from; x < to; x += 1) {
      product += columns[x] * resting[x - shift];
      own += columns[x] * columns[x];
      theirs += resting[x - shift] * resting[x - shift];
    }

    const match = own === 0 || theirs === 0 ? 0 : product / Math.sqrt(own * theirs);

    if (match > best.match) best = { shift, match };
  }

  return best;
};

/**
 * The first of `frames` (each its time, shift, and match) from which every later one stands
 * within a pixel of where the screen rests and lines up with it at `match` or better; null when
 * the last frame doesn't.
 */
export const restingFrom = (frames, match = 0.9) => {
  let first = null;

  for (const frame of frames) {
    const resting = Math.abs(frame.shift) <= 1 && frame.match >= match;

    if (!resting) first = null;
    else first ??= frame;
  }

  return first;
};

/** Mean grey-level change between two frames that counts as the whole screen moving. */
const MOVING = 5;

/**
 * How many seconds the recording runs behind actions.tsv's clock: the probe stamps `record-start`
 * before the simulator starts recording, so each press shows that much earlier than its stamp
 * says, plus the time the simulator takes the touch. It is the median, over `presses` (their times
 * by the stamps), of how long before each press's stamp the first frame came that moved the whole
 * screen, within `reach` seconds either side.
 */
export const recordingLag = (presses, framesAround, reach = 1.5) => {
  const lags = presses.flatMap((at) => {
    const frames = framesAround(at - reach, at + reach);
    const moved = frames.findIndex(
      (frame, index) => index > 0 && difference(frame.pixels, frames[index - 1].pixels) >= MOVING,
    );

    return moved < 0 ? [] : [at - frames[moved].t];
  });
  const sorted = [...lags].sort((a, b) => a - b);

  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
};

/**
 * Per launch and press of one `ios timings --record` run, the press's time in the recording and
 * the first frame from which the opened screen stands where it rests (`restingFrom`), lined up
 * with the last frame before the next action.
 */
const settle = (dir) => {
  const video = join(dir, "truth.mp4");
  const actions = parseActions(readFileSync(join(dir, "actions.tsv"), "utf8"));
  const recordStart = actions.find((action) => action.kind === "record-start")?.ms ?? actions[0].ms;
  const { width, height } = sizeOf(video);
  const rows = Math.round(height / 6);
  const at = (action) => (action.ms - recordStart) / 1000;
  const lag = recordingLag(
    actions.filter((action) => action.kind === "press").map(at),
    (from, to) => framesBetween(video, from, to),
  );
  const lines = [
    `# the recording runs ${lag.toFixed(3)} s behind the stamps`,
    "launch\topen\tpress_s\trest_s\tshift_px\tmatch",
  ];
  let launch = 0;
  let open = 0;

  actions.forEach((action, index) => {
    if (action.kind === "launch") {
      launch = Number(action.detail);
      open = 0;
    }

    if (action.kind !== "press") return;
    open += 1;
    const pressed = at(action) - lag;
    const next = actions[index + 1];
    // From just before the press shows to before the next action could: a press's screen moves a
    // moment after its touch, once JavaScript pushes it, while Back moves with the touch. So the
    // last frame is the opened screen at rest.
    const until = next === undefined ? pressed + 2 : at(next) - lag - 0.4;
    const frames = framesSized(video, pressed - 0.3, until, width, rows);
    const resting = edgeColumns(frames.at(-1).pixels, width, rows);
    const lined = frames.map((frame) => ({
      t: frame.t,
      ...shiftOf(edgeColumns(frame.pixels, width, rows), resting, { maxShift: width }),
    }));
    const rest = restingFrom(lined);

    lines.push(
      [
        launch,
        open,
        pressed.toFixed(3),
        rest === null ? "–" : rest.t.toFixed(6),
        rest === null ? "–" : String(rest.shift),
        rest === null ? "–" : rest.match.toFixed(3),
      ].join("\t"),
    );
  });

  writeFileSync(join(dir, "settled.tsv"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
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

const MARK =
  /^(home-screen|home-content|open) ready at ([\d.]+) hitched (true|false) rests at ([\d.]+) hitched (true|false) mounted ([\d.]+)(?: |$)/u;

/**
 * The frame marks in the device's log (`log show --style ndjson`), grouped by process in the order
 * the processes first wrote one: one group per launch. Each mark has its name; when its content was
 * ready (`readyAt`) and at rest (`at`), in milliseconds on the app's clock, each with whether that
 * refresh was hitched; and when the mark entered the window (`mountedAt`), the commit of its
 * content.
 */
export const parseMarks = (text) => {
  const launches = new Map();

  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    const entry = JSON.parse(line);
    const mark = MARK.exec(entry.eventMessage ?? "");

    if (mark === null) continue;
    const marks = launches.get(entry.processID) ?? [];

    marks.push({
      name: mark[1],
      readyAt: Number(mark[2]),
      readyHitched: mark[3] === "true",
      at: Number(mark[4]),
      hitched: mark[5] === "true",
      mountedAt: Number(mark[6]),
    });
    launches.set(entry.processID, marks);
  }

  return [...launches.values()];
};

/**
 * Each open mark of `launches`, by launch and its count in the launch from 1, with the
 * `App.screenOpened` record of the same open from `records` (`media logs --json` lines, in any
 * order): the n-th open mark is the n-th record by time. Without one record per mark, no open has
 * its record.
 */
export const opensOf = (launches, records) => {
  const opens = launches.flatMap((marks, index) =>
    marks
      .filter((mark) => mark.name === "open")
      .map((mark, open) => ({ launch: index + 1, open: open + 1, mark })),
  );
  const opened = records
    .filter((record) => record.message === "App.screenOpened")
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  return opens.map((each, index) => ({
    ...each,
    record: opened.length === opens.length ? opened[index].annotations : null,
  }));
};

/** How many 60 Hz frames a mark and the recording may part by. */
export const AGREE_FRAMES = 3;

/**
 * Per open of `truth` (`launch`, `open`, `home_s`, `open_s`), the app's time from Home's content
 * mark (its screen mark when Home drew no content mark) to that launch's `open`th open mark at
 * rest, the recording's time between the same frames, the difference, whether it is within
 * `AGREE_FRAMES` frames, which marks were hitched, and the open's screen and cache from `opens`.
 */
export const judge = (launches, truth, frameMs, opens = []) =>
  truth.map((row) => {
    const marks = launches[row.launch - 1] ?? [];
    const home =
      marks.find((mark) => mark.name === "home-content") ??
      marks.find((mark) => mark.name === "home-screen");
    const open = marks.filter((mark) => mark.name === "open")[row.open - 1];
    const record = opens.find((each) => each.launch === row.launch && each.open === row.open)?.record;
    const recordedMs = (row.open_s - row.home_s) * 1000;
    const sample = {
      launch: row.launch,
      open: row.open,
      screen: record?.screen ?? null,
      cache: record?.cache ?? null,
      recordedMs,
    };

    if (home === undefined || open === undefined) {
      return { ...sample, appMs: null, difference: null, agrees: false, hitched: [] };
    }

    const appMs = open.at - home.at;
    const difference = appMs - recordedMs;

    return {
      ...sample,
      appMs,
      difference,
      agrees: Math.abs(difference) <= AGREE_FRAMES * frameMs,
      hitched: [home, open].filter((mark) => mark.hitched).map((mark) => mark.name),
    };
  });

/**
 * Per screen and cache state, how many of the `rows` `judge` made, hitched ones aside, agreed,
 * and the lowest and highest difference among them: how steadily the mark tracks the recording.
 */
export const spreadOf = (rows) => {
  const groups = new Map();

  for (const row of rows) {
    if (row.difference === null || row.hitched.length > 0) continue;
    const key = `${row.screen ?? "?"} ${row.cache ?? "?"}`;
    const group = groups.get(key) ?? [];

    group.push(row);
    groups.set(key, group);
  }

  return [...groups].map(([key, group]) => {
    const differences = group.map((row) => row.difference);

    return {
      key,
      n: group.length,
      agree: group.filter((row) => row.agrees).length,
      min: Math.min(...differences),
      max: Math.max(...differences),
    };
  });
};

/**
 * Per open of `opens`, the ready check, which no recording can make during a slide: the touch's
 * time (the ready refresh less the record's `contentReadyMs`), how long from the touch until the
 * commit of the content reached the window (`touchToMountMs`), from that commit to the ready
 * refresh (`mountToReadyMs`, a frame or two), and how long before rest the content was ready
 * (`readyBeforeRestMs`, never negative).
 */
export const readyCheck = (opens) =>
  opens.map(({ launch, open, mark, record }) => {
    const touch = record === null ? null : mark.readyAt - record.contentReadyMs;

    return {
      launch,
      open,
      screen: record?.screen ?? null,
      cache: record?.cache ?? null,
      touchToMountMs: touch === null ? null : mark.mountedAt - touch,
      mountToReadyMs: mark.readyAt - mark.mountedAt,
      readyBeforeRestMs: mark.at - mark.readyAt,
      readyHitched: mark.readyHitched,
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
  } else if (command === "settle" && target !== undefined) {
    settle(target);
  } else if (command === "frames" && target !== undefined && frame !== undefined) {
    sheet(target, process.argv.slice(5).map(Number), frame, 134);
  } else if (command === "judge" && target !== undefined) {
    const frameMs = Number(frame ?? 1000 / 60);
    const launches = parseMarks(readFileSync(join(target, "marks.ndjson"), "utf8"));
    const records = readFileSync(join(target, "records.ndjson"), "utf8")
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line));
    const opens = opensOf(launches, records);
    const rows = judge(launches, parseTruth(readFileSync(join(target, "truth.tsv"), "utf8")), frameMs, opens);

    console.log("At rest: app clock against the recording, Home's mark to each open's.\n");
    console.log("| launch | open | screen, cache | app clock ms | recording ms | difference ms | hitched marks |");
    console.log("| --: | --: | --- | --: | --: | --: | --- |");

    for (const row of rows) {
      console.log(
        `| ${String(row.launch)} | ${String(row.open)} | ${row.screen ?? "?"}, ${row.cache ?? "?"} | ${round(row.appMs)} | ${round(row.recordedMs)} | ${round(row.difference)} | ${row.hitched.join(", ") || "none"} |`,
      );
    }

    const steady = rows.filter((row) => row.hitched.length === 0);
    const agree = steady.filter((row) => row.agrees).length;

    console.log(
      `\n${String(agree)} of ${String(steady.length)} opens with no hitched mark agree within ${String(AGREE_FRAMES)} frames (${round(AGREE_FRAMES * frameMs)} ms); ${agree === steady.length ? "the at-rest marks track the screen" : "DISAGREES"}. ${String(rows.length - steady.length)} hitched aside.\n`,
    );
    console.log("| screen, cache | n | agree | difference min–max ms | spread ms |");
    console.log("| --- | --: | --: | --: | --: |");

    for (const group of spreadOf(rows)) {
      console.log(
        `| ${group.key.replace(" ", ", ")} | ${String(group.n)} | ${String(group.agree)} | ${round(group.min)} to ${round(group.max)} | ${round(group.max - group.min)} |`,
      );
    }

    const checks = readyCheck(opens);

    console.log("\nReady: from the device log and the records, per open.\n");
    console.log("| launch | open | screen, cache | touch → commit ms | commit → ready ms | ready before rest ms |");
    console.log("| --: | --: | --- | --: | --: | --: |");

    for (const check of checks) {
      console.log(
        `| ${String(check.launch)} | ${String(check.open)} | ${check.screen ?? "?"}, ${check.cache ?? "?"} | ${round(check.touchToMountMs)} | ${round(check.mountToReadyMs)} | ${round(check.readyBeforeRestMs)} |`,
      );
    }

    const late = checks.filter((check) => check.readyBeforeRestMs < 0).length;

    console.log(
      `\n${late === 0 ? "No" : String(late)} open${late === 1 ? " was" : "s were"} ready after rest.`,
    );
  } else {
    console.error(
      "usage: node app-timings-truth.mjs sheets <app-timings-dir> | settle <app-timings-dir> | judge <app-timings-dir> [frame-ms] | frames <truth.mp4> <out.png> <seconds>...",
    );
    process.exit(2);
  }
}
