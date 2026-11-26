// The app timing probe's arithmetic: which of the media service's retained log records hold which
// launch or screen-open metric, each metric's median and spread, and how two passes differ.
// `verify-media.sh ios timings` drives the simulator, reads the records the service received with
// the media CLI, and runs this:
//
//   node app-timings.mjs <movies|music> <records.ndjson>
//   node app-timings.mjs compare <movies|music> <pass-1.ndjson> <pass-2.ndjson>
//
// Each record is one line of `media logs --json`: `App.launched` with `firstScreenVisibleMs` and
// `homeContentVisibleMs`, or `App.screenOpened` with `screen`, `cache`, and `contentVisibleMs`
// (apps/media/src/diagnostics/app-events.ts). Every value ends on a frame the app saw drawn.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const launched = (field) => (record) =>
  record.message === "App.launched" ? record.annotations[field] : undefined;

const opened = (screen, cache) => (record) =>
  record.message === "App.screenOpened" &&
  record.annotations.screen === screen &&
  record.annotations.cache === cache
    ? record.annotations.contentVisibleMs
    : undefined;

/**
 * The metrics the probe reports, in its table's order, and how each reads a record. A launch runs
 * from the process start; an open from the touch that ended the press, per cache state: `fetched`,
 * the screen asked for its content after it mounted; `kept`, the SDK already held it.
 */
export const METRICS = [
  { name: "cold launch, Home's screen visible", read: launched("firstScreenVisibleMs") },
  { name: "cold launch, Home's content visible", read: launched("homeContentVisibleMs") },
  ...["title", "album", "artist"].flatMap((screen) =>
    ["fetched", "kept"].map((cache) => ({
      name: `${screen} open, content visible (${cache})`,
      read: opened(screen, cache),
    })),
  ),
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

/**
 * Two passes of the same probe side by side, per metric both have: each pass's median and
 * interquartile range, how far the second median moved from the first, and whether the ranges
 * overlap. The move between two passes of one build is the noise a change has to beat.
 */
export const compare = (first, second, app) => {
  const before = summarize(first, app);
  const after = summarize(second, app);

  return before.flatMap((row, index) => {
    const other = after[index];

    if (row.n === 0 || other.n === 0) return [];

    return [
      {
        name: row.name,
        first: row,
        second: other,
        moved: other.median - row.median,
        overlap: row.p25 <= other.p75 && other.p25 <= row.p75,
      },
    ];
  });
};

/** A comparison as a Markdown table. */
export const comparisonTable = (app, rows) =>
  [
    `| ${app} | pass 1 median (p25–p75) | pass 2 median (p25–p75) | moved | IQRs overlap |`,
    "| --- | --: | --: | --: | :-: |",
    ...rows.map(
      ({ name, first, second, moved, overlap }) =>
        `| ${name} | ${ms(first.median)} (${ms(first.p25)}–${ms(first.p75)}) | ${ms(second.median)} (${ms(second.p25)}–${ms(second.p75)}) | ${moved >= 0 ? "+" : ""}${ms(moved)} | ${overlap ? "yes" : "no"} |`,
    ),
  ].join("\n");

/** The records in `text`, one JSON object per line; blank lines are skipped. */
export const parseRecords = (text) =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

const isApp = (app) => app === "movies" || app === "music";

const usage = () => {
  console.error(
    "usage: node app-timings.mjs <movies|music> <records.ndjson>\n" +
      "       node app-timings.mjs compare <movies|music> <pass-1.ndjson> <pass-2.ndjson>",
  );
  process.exit(2);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const read = (file) => parseRecords(readFileSync(file, "utf8"));

  if (args[0] === "compare") {
    const [, app, first, second] = args;

    if (!isApp(app) || first === undefined || second === undefined) usage();
    console.log(comparisonTable(app, compare(read(first), read(second), app)));
  } else {
    const [app, file] = args;

    if (!isApp(app) || file === undefined) usage();
    const records = read(file);
    const development = records.some((record) => record.annotations?.development === true);

    console.log(table(app, summarize(records, app)));
    console.log(
      `\n${development ? "Development" : "Production"} JavaScript. Launches run from the process start, opens from the touch that ended the press; each ends on the first frame that showed it.`,
    );
  }
}
