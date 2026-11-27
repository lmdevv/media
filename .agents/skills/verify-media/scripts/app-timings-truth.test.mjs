import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  edgeColumns,
  judge,
  opensOf,
  parseActions,
  parseMarks,
  readyCheck,
  recordingLag,
  restingFrom,
  shiftOf,
  spreadOf,
} from "./app-timings-truth.mjs";

/** One frame mark as `log show --style ndjson` prints it, ready `lead` ms before rest. */
const logged = (processID, name, at, hitched = false, lead = 0) =>
  JSON.stringify({
    processID,
    subsystem: "dev.lmdevv.launch-clock",
    eventMessage: `${name} ready at ${(at - lead).toFixed(3)} hitched false rests at ${at.toFixed(3)} hitched ${String(hitched)} mounted ${(at - lead - 10).toFixed(3)} gap ${hitched ? "33.333" : "0.000"} past -0.712`,
  });

const LOG = [
  "Filtering the log data using \"subsystem == \\\"dev.lmdevv.launch-clock\\\"\"",
  logged(501, "home-screen", 10_000),
  logged(501, "home-content", 10_016.667, true),
  logged(501, "open", 14_250, false, 400),
  logged(501, "open", 18_000, false, 500),
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
  assert.deepEqual(launches[0]?.[1], {
    name: "home-content",
    readyAt: 10_016.667,
    readyHitched: false,
    at: 10_016.667,
    hitched: true,
    mountedAt: 10_006.667,
  });
  assert.deepEqual(launches[1]?.map((mark) => mark.name), ["home-screen", "open"]);
});

test("compares the app's Home-to-open time at rest with the recording's for each open, within three frames", () => {
  const rows = judge(
    parseMarks(LOG),
    [
      { launch: 1, open: 1, home_s: 3.2, open_s: 7.45 },
      { launch: 1, open: 2, home_s: 3.2, open_s: 11.2 },
      { launch: 2, open: 1, home_s: 40, open_s: 43.06 },
      { launch: 2, open: 2, home_s: 40, open_s: 44 },
      { launch: 3, open: 1, home_s: 80, open_s: 81 },
    ],
    1000 / 60,
  );

  assert.deepEqual(
    rows.map(({ launch, open, appMs, agrees, hitched }) => ({
      launch,
      open,
      appMs: appMs === null ? null : Math.round(appMs),
      agrees,
      hitched,
    })),
    [
      { launch: 1, open: 1, appMs: 4233, agrees: true, hitched: ["home-content"] },
      { launch: 1, open: 2, appMs: 7983, agrees: true, hitched: ["home-content"] },
      { launch: 2, open: 1, appMs: 3100, agrees: true, hitched: [] },
      { launch: 2, open: 2, appMs: null, agrees: false, hitched: [] },
      { launch: 3, open: 1, appMs: null, agrees: false, hitched: [] },
    ],
  );
  assert.equal(Math.round(rows[0]?.difference ?? 0), -17);
});

/** A grey frame `width` by `height` of black with white bars `width`/8 apart, moved `shift` right. */
const barred = (width, height, shift) => {
  const pixels = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = x - shift;

      pixels[y * width + x] = from >= 0 && from % 37 < 3 + (from % 5) ? 255 : 0;
    }
  }

  return pixels;
};

test("finds how far a frame's screen stands from where it rests, to the pixel", () => {
  const resting = edgeColumns(barred(402, 60, 0), 402, 60);

  for (const shift of [0, 1, 7, 120, 240]) {
    assert.equal(shiftOf(edgeColumns(barred(402, 60, shift), 402, 60), resting, { maxShift: 402 }).shift, shift);
  }
});

test("finds how far the recording runs behind the stamps from when each press moved the screen", () => {
  const size = 134 * 291;
  const still = new Uint8Array(size);
  const moved = new Uint8Array(size).fill(80);
  // The screen moves 0.6 s before each press's stamp, 0.4 s before one, and never near another.
  const movesAt = new Map([
    [10, 9.4],
    [20, 19.4],
    [30, 29.6],
  ]);
  const framesAround = (from, to) =>
    Array.from({ length: Math.round((to - from) * 60) }, (_, index) => {
      const t = from + index / 60;
      const at = movesAt.get(Math.round(from + 1.5));

      return { t, pixels: at !== undefined && t >= at ? moved : still };
    });

  assert.equal(Number(recordingLag([10, 20, 30, 40], framesAround).toFixed(2)), 0.6);
});

test("takes the first frame from which the screen stays at rest and lines up with its last frame", () => {
  const frames = [
    { t: 1.0, shift: 300, match: 0.95 },
    { t: 1.1, shift: 2, match: 0.97 },
    { t: 1.2, shift: 1, match: 0.98 },
    { t: 1.3, shift: 3, match: 0.98 },
    { t: 1.4, shift: 0, match: 0.99 },
    { t: 1.5, shift: 0, match: 1 },
  ];

  assert.equal(restingFrom(frames)?.t, 1.4);
  assert.equal(restingFrom([{ t: 1, shift: 0, match: 0.4 }, { t: 2, shift: 0, match: 0.95 }])?.t, 2);
  assert.equal(restingFrom([{ t: 1, shift: 0, match: 1 }, { t: 2, shift: 5, match: 1 }]), null);
});

test("pairs each open mark with its record, and checks ready against the commit and rest", () => {
  const record = (timestamp, screen, cache, contentReadyMs) =>
    ({ message: "App.screenOpened", timestamp, annotations: { screen, cache, contentReadyMs } });
  const opens = opensOf(parseMarks(LOG), [
    record("2026-11-27T10:00:09.000Z", "title", "fetched", 300),
    record("2026-11-27T10:00:05.000Z", "title", "kept", 120),
    record("2026-11-27T10:00:02.000Z", "title", "fetched", 250),
  ]);

  assert.deepEqual(
    readyCheck(opens).map(({ launch, open, cache, touchToMountMs, mountToReadyMs, readyBeforeRestMs }) => ({
      launch,
      open,
      cache,
      touchToMountMs,
      mountToReadyMs,
      readyBeforeRestMs,
    })),
    [
      { launch: 1, open: 1, cache: "fetched", touchToMountMs: 240, mountToReadyMs: 10, readyBeforeRestMs: 400 },
      { launch: 1, open: 2, cache: "kept", touchToMountMs: 110, mountToReadyMs: 10, readyBeforeRestMs: 500 },
      { launch: 2, open: 1, cache: "fetched", touchToMountMs: 290, mountToReadyMs: 10, readyBeforeRestMs: 0 },
    ],
  );
  assert.equal(opensOf(parseMarks(LOG), [])[0]?.record, null);
});

test("sums up each screen and cache state's differences, hitched samples aside", () => {
  const row = (screen, cache, difference, hitched = []) => ({
    screen,
    cache,
    difference,
    agrees: Math.abs(difference) <= 50,
    hitched,
  });

  assert.deepEqual(
    spreadOf([
      row("title", "kept", -10),
      row("title", "kept", 6),
      row("title", "fetched", -45),
      row("title", "fetched", 90, ["open"]),
    ]),
    [
      { key: "title kept", n: 2, agree: 2, min: -10, max: 6 },
      { key: "title fetched", n: 1, agree: 1, min: -45, max: -45 },
    ],
  );
});

test("the command prints the per-open table from a run's marks, records, and truth.tsv", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-timings-truth-"));

  writeFileSync(join(dir, "marks.ndjson"), LOG);
  writeFileSync(join(dir, "records.ndjson"), "");
  writeFileSync(join(dir, "truth.tsv"), "launch\topen\thome_s\topen_s\n1\t1\t3.2\t7.45\n");

  const script = fileURLToPath(new URL("./app-timings-truth.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "judge", dir, "16.667"], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| 1 \| 1 \| \?, \? \| 4233 \| 4250 \| -17 \| home-content \|/u);
  assert.match(result.stdout, /0 of 0 opens with no hitched mark agree within 3 frames \(50 ms\)/u);
});
