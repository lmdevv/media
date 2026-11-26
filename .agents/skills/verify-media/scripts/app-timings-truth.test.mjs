import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { judge, parseActions, parseMarks } from "./app-timings-truth.mjs";

/** One frame mark as `log show --style ndjson` prints it. */
const logged = (processID, name, at, hitched = false) =>
  JSON.stringify({
    processID,
    subsystem: "dev.lmdevv.launch-clock",
    eventMessage: `${name} drawn at ${at.toFixed(3)} hitched ${String(hitched)} gap ${hitched ? "33.333" : "0.000"} past -0.712`,
  });

const LOG = [
  "Filtering the log data using \"subsystem == \\\"dev.lmdevv.launch-clock\\\"\"",
  logged(501, "home-screen", 10_000),
  logged(501, "home-content", 10_016.667, true),
  logged(501, "open", 14_250),
  logged(501, "open", 18_000),
  logged(733, "home-screen", 50_000),
  logged(733, "open", 53_100),
  JSON.stringify({ processID: 733, eventMessage: "something else" }),
].join("\n");

test("reads each probe action's time, kind, and detail", () => {
  assert.deepEqual(parseActions("1000\trecord-start\t\n2600\tpress\tSintel|201 483\n"), [
    { ms: 1000, kind: "record-start", detail: "" },
    { ms: 2600, kind: "press", detail: "Sintel|201 483" },
  ]);
});

test("groups the app's frame marks by process, one group per launch", () => {
  const launches = parseMarks(LOG);

  assert.equal(launches.length, 2);
  assert.deepEqual(launches[0]?.[1], { name: "home-content", at: 10_016.667, hitched: true });
  assert.deepEqual(launches[1]?.map((mark) => mark.name), ["home-screen", "open"]);
});

test("compares the app's Home-to-open time with the recording's, with no zero point to fit", () => {
  const rows = judge(
    parseMarks(LOG),
    [
      { launch: 1, home_s: 3.2, open_s: 7.45 },
      { launch: 2, home_s: 40, open_s: 43.0 },
      { launch: 3, home_s: 80, open_s: 81 },
    ],
    1000 / 60,
  );

  assert.deepEqual(
    rows.map(({ launch, appMs, agrees, hitched }) => ({ launch, appMs: appMs === null ? null : Math.round(appMs), agrees, hitched })),
    [
      { launch: 1, appMs: 4233, agrees: true, hitched: ["home-content"] },
      { launch: 2, appMs: 3100, agrees: false, hitched: [] },
      { launch: 3, appMs: null, agrees: false, hitched: [] },
    ],
  );
  assert.equal(Math.round(rows[0]?.difference ?? 0), -17);
});

test("the command prints the per-launch table from a run's marks and truth.tsv", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-timings-truth-"));

  writeFileSync(join(dir, "marks.ndjson"), LOG);
  writeFileSync(join(dir, "truth.tsv"), "launch\thome_s\topen_s\n1\t3.2\t7.45\n");

  const script = fileURLToPath(new URL("./app-timings-truth.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "judge", dir, "16.667"], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| 1 \| 4233 \| 4250 \| -17 \| home-content \|/u);
  assert.match(result.stdout, /1 of 1 launches agree within two frames \(33 ms\); the marks land/u);
});
