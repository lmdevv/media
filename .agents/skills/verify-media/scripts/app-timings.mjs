// The app timing probe's arithmetic: which of the media service's retained log records hold which
// launch or screen-open metric, each metric's median and spread and how many of its samples were
// hitched, how loaded the two machines were, and how two passes differ. `verify-media.sh ios
// timings` drives the simulator, writes a pass folder (the records the service received, read with
// the media CLI, as records.ndjson, and the machines' load as loads.tsv), and runs this:
//
//   node app-timings.mjs <movies|music> <pass-dir>
//   node app-timings.mjs compare <movies|music> <pass-1-dir> <pass-2-dir>
//
// Each record is one line of `media logs --json`: `App.launched` with Home's screen and content
// timings, or `App.screenOpened` with `screen`, `cache`, and the content's timings
// (apps/media/src/diagnostics/app-events.ts). Each timing has two ends, each a refresh the app saw:
// content ready, the first refresh after the content was committed and laid out, wherever it
// stood; and content at rest, the first that showed it in place with any transition over. Each
// says whether its refresh was hitched: it came after a refresh the app missed, so the frame may
// have shown a refresh or more late. The table sets each screen's fetched and kept opens side by
// side, per end, to show how far apart each end puts them against its own spread.
//
// Each line of loads.tsv is the wall clock in milliseconds, when (`start`, `launch N`, or `end`),
// the Mac's one-minute load average and CPU count, and this host's. A pass whose load passed
// `QUIET_LOAD_PER_CPU` on either machine at any of them is loaded, and `compare` refuses it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const launched = (prefix, end) => ({
  read: (record) =>
    record.message === "App.launched" ? record.annotations[`${prefix}${end}Ms`] : undefined,
  hitched: (record) => record.annotations[`${prefix}${end}Hitched`] === true,
});

const opened = (screen, cache, end) => ({
  read: (record) =>
    record.message === "App.screenOpened" &&
    record.annotations.screen === screen &&
    record.annotations.cache === cache
      ? record.annotations[`content${end}Ms`]
      : undefined,
  hitched: (record) => record.annotations[`content${end}Hitched`] === true,
});

/** Each timing's two ends, as the records name them and as the table does. */
const ENDS = [
  ["Ready", "ready"],
  ["AtRest", "at rest"],
];

/**
 * The metrics the probe reports, in its table's order, how each reads a record, and whether that
 * sample was hitched. A launch runs from the process start; an open from the touch that ended the
 * press, per cache state: `fetched`, the screen asked for its content after it mounted; `kept`,
 * the SDK already held it. Each comes as content ready and content at rest.
 */
export const METRICS = [
  ...ENDS.map(([end, label]) => ({
    name: `cold launch, Home's screen ${label}`,
    ...launched("firstScreen", end),
  })),
  ...ENDS.map(([end, label]) => ({
    name: `cold launch, Home's content ${label}`,
    ...launched("homeContent", end),
  })),
  ...["title", "album", "artist"].flatMap((screen) =>
    ENDS.flatMap(([end, label]) =>
      ["fetched", "kept"].map((cache) => ({
        name: `${screen} open, content ${label} (${cache})`,
        screen,
        end: label,
        cache,
        ...opened(screen, cache, end),
      })),
    ),
  ),
];

/**
 * The highest one-minute load average per CPU at which each machine counts as quiet: the Mac that
 * runs the simulator, and this host, which runs the stack and Metro.
 */
export const QUIET_LOAD_PER_CPU = { mac: 0.4, host: 0.5 };

/** The lines of loads.tsv. */
export const parseLoads = (text) =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [ms, at, macLoad, macCpus, hostLoad, hostCpus] = line.split("\t");

      return {
        ms: Number(ms),
        at,
        mac: { load: Number(macLoad), cpus: Number(macCpus) },
        host: { load: Number(hostLoad), cpus: Number(hostCpus) },
      };
    });

/**
 * How loaded each machine was over a pass's load lines: the lowest and highest load, its CPUs, and
 * the load it counts as quiet up to; whether the pass is quiet, and which machines were not.
 */
export const passLoad = (rows) => {
  const machine = (key) => {
    const loads = rows.map((row) => row[key].load).filter(Number.isFinite);
    const cpus = rows.find((row) => Number.isFinite(row[key].cpus))?.[key].cpus ?? Number.NaN;

    return {
      min: Math.min(...loads),
      max: Math.max(...loads),
      cpus,
      quietUpTo: QUIET_LOAD_PER_CPU[key] * cpus,
      measured: loads.length === rows.length && rows.length > 0,
    };
  };
  const mac = machine("mac");
  const host = machine("host");
  const loaded = [
    ["the Mac", mac],
    ["this host", host],
  ].filter(([, each]) => !each.measured || !(each.max <= each.quietUpTo));

  return { mac, host, samples: rows.length, quiet: loaded.length === 0, loaded: loaded.map(([name]) => name) };
};

const loadFigure = (name, { min, max, cpus }) =>
  `${name} ${min.toFixed(1)}–${max.toFixed(1)} of ${String(cpus)} CPUs`;

/** One line on how loaded a pass was, and whether its numbers can be compared. */
export const loadLine = (load) => {
  if (load.samples === 0) return "Load: not recorded, so this pass can't be compared with another.";
  const figures = `${loadFigure("the Mac", load.mac)}, ${loadFigure("this host", load.host)}`;

  return load.quiet
    ? `Load (one-minute average, at the start, each launch, and the end): ${figures}. Quiet.`
    : `Load (one-minute average, at the start, each launch, and the end): ${figures}. LOADED (${load.loaded.join(" and ")} past ${QUIET_LOAD_PER_CPU.mac} per CPU for the Mac, ${QUIET_LOAD_PER_CPU.host} for this host): not comparable with another pass.`;
};

/**
 * Why two passes can't be compared: either was loaded, or recorded no load. Empty when both were
 * quiet.
 */
export const notComparable = (first, second) =>
  [
    ["pass 1", first],
    ["pass 2", second],
  ].flatMap(([name, load]) => (load.quiet ? [] : [`${name}: ${loadLine(load)}`]));

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

/** Each metric's spread over the records `app` sent, and how many of its samples were hitched. */
export const summarize = (records, app) => {
  const own = records.filter((record) => record.annotations?.app === app);

  return METRICS.map(({ name, read, hitched, screen, end, cache }) => {
    const samples = own.filter((record) => typeof read(record) === "number");

    return {
      name,
      screen,
      end,
      cache,
      hitched: samples.filter(hitched).length,
      ...spread(samples.map(read)),
    };
  });
};

const ms = (value) => (value === null ? "–" : String(Math.round(value)));

/** The summary as a Markdown table, leaving out the metrics `app` has no records for. */
export const table = (app, rows) =>
  [
    `| ${app} | n | hitched | median ms | p25–p75 ms | min–max ms |`,
    "| --- | --: | --: | --: | --: | --: |",
    ...rows
      .filter((row) => row.n > 0)
      .map(
        (row) =>
          `| ${row.name} | ${String(row.n)} | ${String(row.hitched)} | ${ms(row.median)} | ${ms(row.p25)}–${ms(row.p75)} | ${ms(row.min)}–${ms(row.max)} |`,
      ),
  ].join("\n");

/**
 * Per screen and end, its fetched and kept opens from the `summarize` rows: each median and
 * interquartile range, how much longer fetched ran, and whether the two ranges overlap, which
 * says whether that end tells the two cache states apart in this pass.
 */
export const separation = (rows) =>
  rows.flatMap((row, index) => {
    const kept = rows[index + 1];

    if (row.cache !== "fetched" || kept?.cache !== "kept" || row.n === 0 || kept.n === 0) return [];

    return [
      {
        screen: row.screen,
        end: row.end,
        fetched: row,
        kept,
        apart: row.median - kept.median,
        overlap: row.p25 <= kept.p75 && kept.p25 <= row.p75,
      },
    ];
  });

/** A separation as a Markdown table. */
export const separationTable = (rows) =>
  [
    "| screen, end | fetched median (p25–p75) | kept median (p25–p75) | fetched longer by | IQRs overlap |",
    "| --- | --: | --: | --: | :-: |",
    ...rows.map(
      ({ screen, end, fetched, kept, apart, overlap }) =>
        `| ${screen}, ${end} | ${ms(fetched.median)} (${ms(fetched.p25)}–${ms(fetched.p75)}) | ${ms(kept.median)} (${ms(kept.p25)}–${ms(kept.p75)}) | ${ms(apart)} | ${overlap ? "yes" : "no"} |`,
    ),
  ].join("\n");

/**
 * Two passes of the same probe side by side, per metric both have: each pass's median and
 * interquartile range, how far the second median moved from the first, and whether the ranges
 * overlap. The move between two quiet passes of one build is the noise a change has to beat.
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

/** A pass folder's records and load. */
export const readPass = (dir) => {
  const loads = join(dir, "loads.tsv");

  return {
    records: parseRecords(readFileSync(join(dir, "records.ndjson"), "utf8")),
    load: passLoad(existsSync(loads) ? parseLoads(readFileSync(loads, "utf8")) : []),
  };
};

const isApp = (app) => app === "movies" || app === "music";

const usage = () => {
  console.error(
    "usage: node app-timings.mjs <movies|music> <pass-dir>\n" +
      "       node app-timings.mjs compare <movies|music> <pass-1-dir> <pass-2-dir>",
  );
  process.exit(2);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);

  if (args[0] === "compare") {
    const [, app, first, second] = args;

    if (!isApp(app) || first === undefined || second === undefined) usage();
    const [one, two] = [readPass(first), readPass(second)];
    const refusals = notComparable(one.load, two.load);

    if (refusals.length > 0) {
      console.log(`Not comparable, so no difference is reported:\n${refusals.map((each) => `- ${each}`).join("\n")}`);
      process.exit(3);
    }

    console.log(comparisonTable(app, compare(one.records, two.records, app)));
  } else {
    const [app, dir] = args;

    if (!isApp(app) || dir === undefined) usage();
    const { records, load } = readPass(dir);
    const development = records.some((record) => record.annotations?.development === true);
    const devServer = records.some((record) => record.annotations?.bundle === "dev-server");

    const rows = summarize(records, app);

    console.log(table(app, rows));
    console.log(`\n${separationTable(separation(rows))}`);
    console.log(
      `\n${development ? "Development" : "Production"} JavaScript${devServer ? " from a dev server, whose download every launch includes" : ""}. Launches run from the process start the kernel records, which no recording shows; opens from the touch that ended the press. Content ready ends on the first refresh after the content was committed and laid out, wherever it stood: under the splash screen, or partway through the push. Content at rest ends on the first refresh that showed it in place with the push over, which the push's length sets a floor under. A hitched sample's frame came after a refresh the app missed and may have shown a refresh or more later.`,
    );
    console.log(loadLine(load));
  }
}
