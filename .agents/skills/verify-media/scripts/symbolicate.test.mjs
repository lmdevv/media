import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { describeFrame, describeRecords, resolver } from "./symbolicate.mjs";

// Bundle line 1, column 0 comes from src/album.ts line 1, column 0, named `openAlbum`; bundle line
// 2, column 4 from line 3, column 2, named `boom`.
const MAP = {
  version: 3,
  sources: ["src/album.ts"],
  names: ["openAlbum", "boom"],
  mappings: "AAAAA;IAEEC",
};

const record = {
  timestamp: "2026-11-26T09:00:00.000Z",
  message: "Client.error",
  annotations: {
    app: "music",
    appVersion: "0.9.0",
    bundle: "embedded",
    errorClass: "TypeError",
    route: "/(app)/(tabs)/(home)",
    frames: [
      { source: "bundle", line: 2, column: 5 },
      { source: "other", line: 1, column: 30 },
      { source: "bundle", line: 9, column: 1 },
    ],
  },
};

test("turns a bundle frame's line and column, counted from 1, into its source and name", () => {
  const resolve = resolver(MAP);

  assert.deepEqual(resolve({ line: 2, column: 5 }), { file: "src/album.ts", line: 3, column: 3, name: "boom" });
  assert.equal(describeFrame(resolve, { source: "native", line: 0, column: 0 }), "native 0:0");
  assert.equal(describeFrame(resolve, { source: "bundle", line: 9, column: 1 }), "bundle 9:1 → not in the map");
});

test("prints each error record with its frames resolved, and nothing for other records", () => {
  const text = [JSON.stringify(record), JSON.stringify({ message: "App.launched", annotations: {} })].join("\n");

  assert.deepEqual(describeRecords(resolver(MAP), text), [
    [
      "2026-11-26T09:00:00.000Z music 0.9.0 (embedded) TypeError on /(app)/(tabs)/(home)",
      "  bundle 2:5 → src/album.ts:3:3 (boom)",
      "  other 1:30",
      "  bundle 9:1 → not in the map",
    ].join("\n"),
  ]);
});

test("the command reads records from its input, or positions from its arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "symbolicate-"));
  const map = join(dir, "main.jsbundle.map");
  const script = fileURLToPath(new URL("./symbolicate.mjs", import.meta.url));

  writeFileSync(map, JSON.stringify(MAP));

  const piped = spawnSync(process.execPath, [script, map], { input: JSON.stringify(record), encoding: "utf8" });
  const named = spawnSync(process.execPath, [script, map, "1:1"], { encoding: "utf8" });

  assert.equal(piped.status, 0, piped.stderr);
  assert.match(piped.stdout, /bundle 2:5 → src\/album\.ts:3:3 \(boom\)/u);
  assert.equal(named.stdout.trim(), "bundle 1:1 → src/album.ts:1:1 (openAlbum)");
  assert.equal(spawnSync(process.execPath, [script]).status, 2);
});
