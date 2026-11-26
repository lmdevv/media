import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { judge, parseActions } from "./app-timings-truth.mjs";

test("reads each probe action's time, kind, and detail", () => {
  assert.deepEqual(parseActions("1000\trecord-start\t\n2600\tpress\tSintel|201 483\n"), [
    { ms: 1000, kind: "record-start", detail: "" },
    { ms: 2600, kind: "press", detail: "Sintel|201 483" },
  ]);
});

test("takes the zero points' median difference out, then needs every sample within two frames", () => {
  const rows = [
    { sample: "title-1", logged_ms: 300, zero_s: 10, end_s: 10.267 },
    { sample: "title-2", logged_ms: 310, zero_s: 20, end_s: 20.25 },
    { sample: "title-3", logged_ms: 290, zero_s: 30, end_s: 30.25 },
    { sample: "launch-1", logged_ms: 7000, zero_s: 0, end_s: 7.2 },
    { sample: "launch-2", logged_ms: 7000, zero_s: 0, end_s: 7.0 },
  ];

  const [title, launch] = judge(rows, 1000 / 30);

  assert.equal(title.metric, "title");
  assert.equal(Math.round(title.offset), 40);
  assert.equal(title.agrees, true);
  assert.equal(launch.agrees, false);
});

test("the command prints the acceptance table from truth.tsv", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-timings-truth-"));
  const file = join(dir, "truth.tsv");

  writeFileSync(file, "sample\tlogged_ms\tzero_s\tend_s\nalbum-1\t250\t1\t1.2\n");

  const script = fileURLToPath(new URL("./app-timings-truth.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "judge", file, "33.333"], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| album-1 \| 250 \| 200 \| 50 \| 0 \|/u);
  assert.match(result.stdout, /album: zero offset 50 ms; agrees within two frames \(67 ms\)/u);
});
