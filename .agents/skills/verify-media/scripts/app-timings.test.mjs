import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  compare,
  comparisonTable,
  loadLine,
  notComparable,
  parseLoads,
  parseRecords,
  passLoad,
  separation,
  separationTable,
  spread,
  summarize,
  table,
} from "./app-timings.mjs";

/** A launch record whose screen and content were each ready 100 ms before they came to rest. */
const launch = (app, firstScreenAtRestMs, homeContentAtRestMs = null, hitched = false) => ({
  timestamp: "2026-11-25T15:00:00.000Z",
  level: "INFO",
  message: "App.launched",
  annotations: {
    app,
    launch: "cold",
    firstScreenReadyMs: firstScreenAtRestMs - 100,
    firstScreenReadyHitched: false,
    firstScreenAtRestMs,
    firstScreenAtRestHitched: hitched,
    homeContentReadyMs: homeContentAtRestMs === null ? null : homeContentAtRestMs - 100,
    homeContentReadyHitched: homeContentAtRestMs === null ? null : false,
    homeContentAtRestMs,
    homeContentAtRestHitched: homeContentAtRestMs === null ? null : false,
    development: false,
  },
});

/** An open record whose content was ready at `readyMs` and at rest at `atRestMs`. */
const open = (app, screen, cache, atRestMs, hitched = false, readyMs = atRestMs - 200) => ({
  timestamp: "2026-11-25T15:00:00.000Z",
  level: "INFO",
  message: "App.screenOpened",
  annotations: {
    app,
    screen,
    cache,
    contentReadyMs: readyMs,
    contentReadyHitched: false,
    contentAtRestMs: atRestMs,
    contentAtRestHitched: hitched,
  },
});

/** A loads.tsv line: when, then each machine's one-minute load and CPUs. */
const loadAt = (at, mac, host) => `1000\t${at}\t${String(mac)}\t10\t${String(host)}\t32`;

describe("spread", () => {
  test("interpolates the median and quartiles between the nearest values", () => {
    assert.deepEqual(spread([400, 100, 300, 200]), {
      n: 4,
      median: 250,
      p25: 175,
      p75: 325,
      min: 100,
      max: 400,
    });
  });

  test("reads one value as every figure, and none as no figures", () => {
    assert.deepEqual(spread([42]), { n: 1, median: 42, p25: 42, p75: 42, min: 42, max: 42 });
    assert.equal(spread([]).median, null);
  });
});

describe("summarize", () => {
  const records = [
    launch("music", 1200, 1900, true),
    launch("music", 1000, null),
    launch("music", 1400, 2100),
    launch("movies", 9000, 9900),
    open("music", "album", "fetched", 300),
    open("music", "album", "fetched", 340, true),
    open("music", "album", "kept", 120),
    open("music", "artist", "fetched", 500),
    { timestamp: "", level: "WARN", message: "Client.error", annotations: { app: "music" } },
  ];

  const rows = Object.fromEntries(summarize(records, "music").map((row) => [row.name, row]));

  test("reads each metric from its own app's records only", () => {
    assert.equal(rows["cold launch, Home's screen at rest"].n, 3);
    assert.equal(rows["cold launch, Home's screen at rest"].median, 1200);
    assert.equal(rows["artist open, content at rest (fetched)"].n, 1);
    assert.equal(rows["title open, content at rest (fetched)"].n, 0);
  });

  test("reports each open per cache state", () => {
    assert.equal(rows["album open, content at rest (fetched)"].median, 320);
    assert.equal(rows["album open, content at rest (kept)"].median, 120);
  });

  test("counts each metric's hitched samples", () => {
    assert.equal(rows["cold launch, Home's screen at rest"].hitched, 1);
    assert.equal(rows["cold launch, Home's content at rest"].hitched, 0);
    assert.equal(rows["album open, content at rest (fetched)"].hitched, 1);
  });

  test("leaves a launch whose Home showed no content out of the content metric", () => {
    assert.equal(rows["cold launch, Home's content at rest"].n, 2);
    assert.equal(rows["cold launch, Home's content at rest"].median, 2000);
  });

  test("prints a table of the metrics it has records for", () => {
    const printed = table("music", summarize(records, "music"));

    assert.match(printed, /^\| music \| n \| hitched \| median ms/u);
    assert.match(printed, /\| cold launch, Home's screen at rest \| 3 \| 1 \| 1200 \| 1100–1300 \| 1000–1400 \|/u);
    assert.doesNotMatch(printed, /title open/u);
  });
});

describe("compare", () => {
  test("puts two passes side by side, with how far the median moved and whether the IQRs overlap", () => {
    const first = [launch("movies", 6700), launch("movies", 6800), launch("movies", 6900)];
    const second = [launch("movies", 7300), launch("movies", 7400), launch("movies", 7500)];
    const rows = compare(first, second, "movies");

    assert.deepEqual(
      rows.map(({ name, moved, overlap }) => ({ name, moved, overlap })),
      [
        { name: "cold launch, Home's screen ready", moved: 600, overlap: false },
        { name: "cold launch, Home's screen at rest", moved: 600, overlap: false },
      ],
    );
    assert.match(comparisonTable("movies", rows), /\| 6800 \(6750–6850\) \| 7400 \(7350–7450\) \| \+600 \| no \|/u);
    assert.equal(compare(first, first, "movies")[0]?.overlap, true);
  });
});

describe("separation", () => {
  test("sets each screen's fetched and kept opens side by side, per end", () => {
    const records = [
      ...[600, 610, 620].map((ms) => open("movies", "title", "fetched", ms, false, ms - 340)),
      ...[612, 618, 630].map((ms) => open("movies", "title", "kept", ms, false, ms - 520)),
    ];
    const rows = separation(summarize(records, "movies"));

    assert.deepEqual(
      rows.map(({ screen, end, apart, overlap }) => ({ screen, end, apart, overlap })),
      [
        { screen: "title", end: "ready", apart: 172, overlap: false },
        { screen: "title", end: "at rest", apart: -8, overlap: true },
      ],
    );
    assert.match(separationTable(rows), /\| title, ready \| 270 \(265–275\) \| 98 \(95–104\) \| 172 \| no \|/u);
  });
});

describe("load", () => {
  test("calls a pass quiet only when both machines stayed at or under their bound every time", () => {
    const quiet = passLoad(parseLoads([loadAt("start", 1.3, 9), loadAt("launch 1", 2.6, 16), loadAt("end", 2, 10)].join("\n")));

    assert.deepEqual(
      { mac: [quiet.mac.min, quiet.mac.max, quiet.mac.quietUpTo], quiet: quiet.quiet },
      { mac: [1.3, 2.6, 4], quiet: true },
    );
    assert.match(loadLine(quiet), /the Mac 1\.3–2\.6 of 10 CPUs, this host 9\.0–16\.0 of 32 CPUs\. Quiet\./u);

    const loaded = passLoad(parseLoads([loadAt("start", 55.23, 9), loadAt("end", 4.08, 9)].join("\n")));

    assert.equal(loaded.quiet, false);
    assert.deepEqual(loaded.loaded, ["the Mac"]);
    assert.match(loadLine(loaded), /LOADED \(the Mac past 0\.4 per CPU/u);
    assert.equal(passLoad([]).quiet, false);
  });

  test("refuses to compare a loaded pass, or one that recorded no load", () => {
    const quiet = passLoad(parseLoads(loadAt("start", 1, 4)));
    const loaded = passLoad(parseLoads(loadAt("start", 1, 25)));

    assert.deepEqual(notComparable(quiet, quiet), []);
    assert.equal(notComparable(quiet, loaded).length, 1);
    assert.match(notComparable(quiet, loaded)[0], /^pass 2: .*this host past/u);
    assert.match(notComparable(passLoad([]), quiet)[0], /^pass 1: Load: not recorded/u);
  });
});

test("the command prints a pass's table and load, and compares two quiet passes only", () => {
  const pass = (name, mac) => {
    const dir = join(mkdtempSync(join(tmpdir(), "app-timings-")), name);

    mkdirSync(dir);
    writeFileSync(join(dir, "records.ndjson"), `${JSON.stringify(open("movies", "title", "kept", 812, true))}\n\n`);
    writeFileSync(join(dir, "loads.tsv"), `${loadAt("start", mac, 4)}\n${loadAt("end", mac, 4)}\n`);

    return dir;
  };
  const quiet = pass("quiet", 1.5);
  const loaded = pass("loaded", 55);

  assert.equal(parseRecords(`${JSON.stringify(open("movies", "title", "kept", 1))}\n`).length, 1);

  const script = fileURLToPath(new URL("./app-timings.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "movies", quiet], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| title open, content at rest \(kept\) \| 1 \| 1 \| 812 \|/u);
  assert.match(result.stdout, /Production JavaScript/u);
  assert.match(result.stdout, /Quiet\./u);
  assert.equal(spawnSync(process.execPath, [script, "books", quiet]).status, 2);

  const compared = spawnSync(process.execPath, [script, "compare", "movies", quiet, quiet], {
    encoding: "utf8",
  });

  assert.equal(compared.status, 0, compared.stderr);
  assert.match(compared.stdout, /\| title open, content at rest \(kept\) \| 812 \(812–812\) \| 812 \(812–812\) \| \+0 \| yes \|/u);

  const refused = spawnSync(process.execPath, [script, "compare", "movies", quiet, loaded], {
    encoding: "utf8",
  });

  assert.equal(refused.status, 3);
  assert.match(refused.stdout, /^Not comparable, so no difference is reported:\n- pass 2: .*LOADED/u);
  assert.doesNotMatch(refused.stdout, /moved/u);
});
