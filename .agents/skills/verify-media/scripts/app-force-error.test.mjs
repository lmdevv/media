import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { debuggerUrl, EXPRESSIONS, FORGED, PRIVATE, SYNTHETIC } from "./app-force-error.mjs";

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

test("puts each piece of private text in both errors, to check no report carries it", () => {
  for (const text of PRIVATE) {
    assert.ok(EXPRESSIONS.fatal.includes(text), text);
    assert.ok(EXPRESSIONS.rejection.includes(text), text);
  }
});

test("names a made-up person, title, file, and host in the synthetic rejection's name and stack", () => {
  assert.match(EXPRESSIONS.synthetic, /failure\.name = "NereaMarlow"/u);

  for (const word of SYNTHETIC) assert.ok(EXPRESSIONS.synthetic.includes(word), word);
  assert.doesNotThrow(() => new Function(`return ${EXPRESSIONS.synthetic}`));
});

test("rejects from the bundle's own module loader", () => {
  assert.match(EXPRESSIONS.bundle, /globalThis\.__r\(/u);
});

test("rejects with six SDK look-alikes, each with its own request id, none of them an SDK error", async () => {
  const rejected = [];
  const reject = Promise.reject;

  Promise.reject = (cause) => {
    rejected.push(cause);

    return { catch: () => undefined };
  };

  try {
    assert.equal(new Function(`return ${EXPRESSIONS.forged}`)(), "rejected with six look-alikes of an SDK error");
  } finally {
    Promise.reject = reject;
  }

  assert.deepEqual(
    rejected.map((cause) => cause.requestId),
    FORGED,
  );
  assert.ok(rejected.every((cause) => cause._tag === "TransportError" || cause instanceof TypeError));
});

test("refuses a kind of error it does not know", () => {
  const script = fileURLToPath(new URL("./app-force-error.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "8081", "slow"], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/u);
});
