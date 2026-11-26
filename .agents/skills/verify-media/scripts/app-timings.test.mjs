import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { compare, comparisonTable, parseRecords, spread, summarize, table } from "./app-timings.mjs";

const launch = (app, firstScreenVisibleMs, homeContentVisibleMs = null) => ({
  timestamp: "2026-11-25T15:00:00.000Z",
  level: "INFO",
  message: "App.launched",
  annotations: { app, launch: "cold", firstScreenVisibleMs, homeContentVisibleMs, development: false },
});

const open = (app, screen, cache, contentVisibleMs) => ({
  timestamp: "2026-11-25T15:00:00.000Z",
  level: "INFO",
  message: "App.screenOpened",
  annotations: { app, screen, recordId: `${screen}_1`, cache, contentVisibleMs },
});

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
    launch("music", 1200, 1900),
    launch("music", 1000, null),
    launch("music", 1400, 2100),
    launch("movies", 9000, 9900),
    open("music", "album", "fetched", 300),
    open("music", "album", "fetched", 340),
    open("music", "album", "kept", 120),
    open("music", "artist", "fetched", 500),
    { timestamp: "", level: "WARN", message: "Client.error", annotations: { app: "music" } },
  ];

  const rows = Object.fromEntries(summarize(records, "music").map((row) => [row.name, row]));

  test("reads each metric from its own app's records only", () => {
    assert.equal(rows["cold launch, Home's screen visible"].n, 3);
    assert.equal(rows["cold launch, Home's screen visible"].median, 1200);
    assert.equal(rows["artist open, content visible (fetched)"].n, 1);
    assert.equal(rows["title open, content visible (fetched)"].n, 0);
  });

  test("reports each open per cache state", () => {
    assert.equal(rows["album open, content visible (fetched)"].median, 320);
    assert.equal(rows["album open, content visible (kept)"].median, 120);
  });

  test("leaves a launch whose Home showed no content out of the content metric", () => {
    assert.equal(rows["cold launch, Home's content visible"].n, 2);
    assert.equal(rows["cold launch, Home's content visible"].median, 2000);
  });

  test("prints a table of the metrics it has records for", () => {
    const printed = table("music", summarize(records, "music"));

    assert.match(printed, /^\| music \| n \| median ms/u);
    assert.match(printed, /\| cold launch, Home's screen visible \| 3 \| 1200 \| 1100–1300 \| 1000–1400 \|/u);
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
      [{ name: "cold launch, Home's screen visible", moved: 600, overlap: false }],
    );
    assert.match(comparisonTable("movies", rows), /\| 6800 \(6750–6850\) \| 7400 \(7350–7450\) \| \+600 \| no \|/u);
    assert.equal(compare(first, first, "movies")[0]?.overlap, true);
  });
});

test("the command prints the table for an app, and the comparison of two passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-timings-"));
  const file = join(dir, "records.ndjson");

  writeFileSync(file, `${JSON.stringify(open("movies", "title", "kept", 812))}\n\n`);
  assert.equal(parseRecords(`${JSON.stringify(open("movies", "title", "kept", 1))}\n`).length, 1);

  const script = fileURLToPath(new URL("./app-timings.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "movies", file], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| title open, content visible \(kept\) \| 1 \| 812 \|/u);
  assert.match(result.stdout, /Production JavaScript/u);
  assert.equal(spawnSync(process.execPath, [script, "books", file]).status, 2);

  const compared = spawnSync(process.execPath, [script, "compare", "movies", file, file], {
    encoding: "utf8",
  });

  assert.equal(compared.status, 0, compared.stderr);
  assert.match(compared.stdout, /\| title open, content visible \(kept\) \| 812 \(812–812\) \| 812 \(812–812\) \| \+0 \| yes \|/u);
});
