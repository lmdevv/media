import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { debuggerUrl, EXPRESSIONS } from "./app-force-error.mjs";

test("picks the newest app runtime among Metro's inspector targets", () => {
  assert.equal(
    debuggerUrl([
      { title: "React Native Experimental (Improved Chrome Reloads)" },
      { webSocketDebuggerUrl: "ws://127.0.0.1:8081/inspector/debug?page=1" },
      { webSocketDebuggerUrl: "ws://127.0.0.1:8081/inspector/debug?page=2" },
    ]),
    "ws://127.0.0.1:8081/inspector/debug?page=2",
  );
  assert.equal(debuggerUrl([]), undefined);
});

test("throws from a timer for a fatal error, and leaves a rejection unhandled", () => {
  assert.match(EXPRESSIONS.fatal, /^setTimeout\(\(\) => \{ throw new Error/u);
  assert.match(EXPRESSIONS.rejection, /^void Promise\.reject\(/u);
});

test("refuses a kind of error it does not know", () => {
  const script = fileURLToPath(new URL("./app-force-error.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "8081", "slow"], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/u);
});
