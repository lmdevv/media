import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseRecords, spread, summarize, table } from "./app-timings.mjs";

const launch = (app, launch, firstFrameMs, homeMs = null) => ({
  timestamp: "2026-11-25T15:00:00.000Z",
  level: "INFO",
  message: "App.launched",
  annotations: { app, launch, firstFrameMs, homeMs, development: false },
});

const open = (app, screen, openMs) => ({
  timestamp: "2026-11-25T15:00:00.000Z",
  level: "INFO",
  message: "App.screenOpened",
  annotations: { app, screen, recordId: `${screen}_1`, openMs },
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
    launch("music", "cold", 1200, 1900),
    launch("music", "cold", 1000, null),
    launch("music", "cold", 1400, 2100),
    launch("music", "warm", 30),
    launch("movies", "cold", 9000, 9900),
    open("music", "album", 300),
    open("music", "artist", 500),
    open("music", "album", 340),
    { timestamp: "", level: "WARN", message: "Client.error", annotations: { app: "music" } },
  ];

  const rows = Object.fromEntries(summarize(records, "music").map((row) => [row.name, row]));

  test("reads each metric from its own app's records only", () => {
    assert.equal(rows["cold launch, first frame (TTID)"].n, 3);
    assert.equal(rows["cold launch, first frame (TTID)"].median, 1200);
    assert.equal(rows["warm launch, first frame"].median, 30);
    assert.equal(rows["album open"].median, 320);
    assert.equal(rows["artist open"].n, 1);
    assert.equal(rows["title open"].n, 0);
  });

  test("leaves a launch that never reached Home out of the Home metric", () => {
    assert.equal(rows["cold launch, Home content (TTFD)"].n, 2);
    assert.equal(rows["cold launch, Home content (TTFD)"].median, 2000);
  });

  test("prints a table of the metrics it has records for", () => {
    const printed = table("music", summarize(records, "music"));

    assert.match(printed, /^\| music \| n \| median ms/u);
    assert.match(printed, /\| cold launch, first frame \(TTID\) \| 3 \| 1200 \| 1100–1300 \| 1000–1400 \|/u);
    assert.doesNotMatch(printed, /title open/u);
  });
});

test("the command prints the table for an app from a records file", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-timings-"));
  const file = join(dir, "records.ndjson");

  writeFileSync(file, `${JSON.stringify(open("movies", "title", 812))}\n\n`);
  assert.equal(parseRecords(`${JSON.stringify(open("movies", "title", 1))}\n`).length, 1);

  const script = fileURLToPath(new URL("./app-timings.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "movies", file], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| title open \| 1 \| 812 \|/u);
  assert.match(result.stdout, /Production JavaScript/u);
  assert.equal(spawnSync(process.execPath, [script, "books", file]).status, 2);
});
