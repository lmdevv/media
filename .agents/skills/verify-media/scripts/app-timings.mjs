// The app timing probe's arithmetic: which of the media service's retained log records hold which
// launch or screen-open metric, and each metric's median and spread. `verify-media.sh ios timings`
// drives the simulator, reads the records the service received with the media CLI, and runs this:
//
//   node app-timings.mjs <movies|music> <records.ndjson>
//
// Each record is one line of `media logs --json`: `App.launched` with `launch`, `firstFrameMs`, and
// `homeMs`, or `App.screenOpened` with `screen` and `openMs` (apps/media/src/diagnostics/app-events.ts).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const launched = (kind, field) => (record) =>
  record.message === "App.launched" && record.annotations.launch === kind
    ? record.annotations[field]
    : undefined;

const opened = (screen) => (record) =>
  record.message === "App.screenOpened" && record.annotations.screen === screen
    ? record.annotations.openMs
    : undefined;

/** The metrics the probe reports, in its table's order, and how each reads a record. */
export const METRICS = [
  { name: "cold launch, first frame (TTID)", read: launched("cold", "firstFrameMs") },
  { name: "cold launch, Home content (TTFD)", read: launched("cold", "homeMs") },
  { name: "warm launch, first frame", read: launched("warm", "firstFrameMs") },
  { name: "title open", read: opened("title") },
  { name: "album open", read: opened("album") },
  { name: "artist open", read: opened("artist") },
];

/** The `p` quantile of ascending `sorted`, interpolating between the two nearest values. */
const quantile = (sorted, p) => {
  const at = (sorted.length - 1) * p;
  const below = Math.floor(at);
  const above = Math.ceil(at);

  return sorted[below] + (sorted[above] - sorted[below]) * (at - below);
};

/** How many values there are, their median, quartiles, and range; null figures when none. */
export const spread = (values) => {
  const sorted = [...values].sort((left, right) => left - right);

  if (sorted.length === 0) {
    return { n: 0, median: null, p25: null, p75: null, min: null, max: null };
  }

  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    min: sorted[0],
    max: sorted.at(-1),
  };
};

/** Each metric's spread over the records `app` sent. */
export const summarize = (records, app) => {
  const own = records.filter((record) => record.annotations?.app === app);

  return METRICS.map(({ name, read }) => ({
    name,
    ...spread(own.map(read).filter((value) => typeof value === "number")),
  }));
};

const ms = (value) => (value === null ? "–" : String(Math.round(value)));

/** The summary as a Markdown table, leaving out the metrics `app` has no records for. */
export const table = (app, rows) =>
  [
    `| ${app} | n | median ms | p25–p75 ms | min–max ms |`,
    "| --- | --: | --: | --: | --: |",
    ...rows
      .filter((row) => row.n > 0)
      .map(
        (row) =>
          `| ${row.name} | ${String(row.n)} | ${ms(row.median)} | ${ms(row.p25)}–${ms(row.p75)} | ${ms(row.min)}–${ms(row.max)} |`,
      ),
  ].join("\n");

/** The records in `text`, one JSON object per line; blank lines are skipped. */
export const parseRecords = (text) =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [app, file] = process.argv.slice(2);

  if ((app !== "movies" && app !== "music") || file === undefined) {
    console.error("usage: node app-timings.mjs <movies|music> <records.ndjson>");
    process.exit(2);
  }

  const records = parseRecords(readFileSync(file, "utf8"));
  const development = records.some((record) => record.annotations?.development === true);

  console.log(table(app, summarize(records, app)));
  console.log(
    `\n${development ? "Development" : "Production"} JavaScript; times in ms from the zero each metric names.`,
  );
}
