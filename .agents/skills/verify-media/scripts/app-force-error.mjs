// Makes the iOS app on a verify-media simulator hit an unexpected error, to check that it reports
// it (`verify-media.sh ios force-error`). It runs one line of JavaScript in the app's runtime through
// Metro's inspector proxy, the way a debugger would:
//
//   node app-force-error.mjs <metro-port> <fatal|rejection|synthetic|bundle>
//
// `fatal` throws from a timer, which React Native hands to its global handler as fatal; `rejection`
// rejects a promise nobody handles. Each error's text names a made-up person, title, file, and
// server, which the report must not carry: `PRIVATE` lists them, to search the log for.
// `synthetic` rejects with an error renamed to a made-up person, whose stack names a title, a file,
// and a host where functions and bundles would be: `SYNTHETIC` lists those words. `bundle` rejects
// from inside the bundle's own module loader (Metro's `__r` asked for no module), so the report's
// top frame is a position in the bundle for its source map to turn back into source. `forged`
// rejects with six look-alikes of an SDK error, each carrying its own request id in the media
// service's shape and an SDK tag: a plain object (the one a reviewer forged), an Error subclass,
// an object given TypeError's prototype by hand, a proxy over an Error, an object that names
// itself an Error, and a real TypeError. A report names none of them `TransportError`, and none
// of the ids in `FORGED` reaches the log.

import { fileURLToPath } from "node:url";

/** The line each kind of error runs in the app. */
export const EXPRESSIONS = {
  fatal:
    'setTimeout(() => { throw new Error("Lucía García could not open Sintel.mkv on http://192.168.1.20:8080"); }, 0); "thrown"',
  rejection:
    'void Promise.reject(new Error("Lucía García could not open Sintel.mkv on http://192.168.1.20:8080")); "rejected"',
  synthetic: [
    "(() => {",
    '  const failure = new Error("Fictional Nerea Marlow opened Cloud Orchard from leaf.mkv on 192.0.2.44:8112");',
    '  failure.name = "NereaMarlow";',
    '  failure.stack = failure.name + ": " + failure.message',
    '    + "\\n    at CloudOrchard (address at /synthetic/NereaMarlow/PrivateLeaf.js:14:9)"',
    '    + "\\n    at travel (https://fictional-lar.js/synthetic/index.bundle:18:2)";',
    "  void Promise.reject(failure);",
    '  return "rejected with a made-up name and stack";',
    "})()",
  ].join("\n"),
  bundle: 'void Promise.resolve().then(() => globalThis.__r(null)); "rejected in the bundle"',
  forged: [
    "(() => {",
    '  const stack = (line) => "x\\n    at Forged (https://forged.invalid/Forged.js:" + line + ":7)";',
    "  void Promise.reject({",
    '    name: "IonaRhee",',
    '    _tag: "TransportError",',
    '    message: "Iona Rhee opened Cedar Lantern from CandleRoom.mkv on 192.0.2.73:9777",',
    '    stack: "Iona Rhee opened Cedar Lantern from CandleRoom.mkv on 192.0.2.73:9777\\n    at CedarLantern (https://candle-room.invalid/tmp/CandleRoom.js:31337:31415)",',
    '    requestId: "deadbeef-cafe-4dad-8bad-feedface2027",',
    "  });",
    "  class ForgedTransport extends Error {}",
    '  const subclass = new ForgedTransport("x");',
    '  subclass._tag = "TransportError";',
    '  subclass.requestId = "c0ffee01-5a1e-4b0b-9a11-0000000000a1";',
    "  subclass.stack = stack(1001);",
    "  void Promise.reject(subclass);",
    "  void Promise.reject(Object.setPrototypeOf(",
    '    { _tag: "TransportError", message: "x", stack: stack(1002), requestId: "c0ffee02-5a1e-4b0b-9a11-0000000000a2" },',
    "    TypeError.prototype,",
    "  ));",
    "  const real = new Error(\"x\");",
    "  real.stack = stack(1003);",
    "  void Promise.reject(new Proxy(real, {",
    '    get: (target, key) => key === "requestId" ? "c0ffee03-5a1e-4b0b-9a11-0000000000a3" : key === "_tag" ? "TransportError" : target[key],',
    "  }));",
    "  void Promise.reject({",
    '    [Symbol.toStringTag]: "Error",',
    '    _tag: "TransportError",',
    '    message: "x",',
    "    stack: stack(1004),",
    '    requestId: "c0ffee04-5a1e-4b0b-9a11-0000000000a4",',
    "  });",
    '  const typed = new TypeError("x");',
    '  typed.requestId = "c0ffee05-5a1e-4b0b-9a11-0000000000a5";',
    "  typed.stack = stack(1005);",
    "  void Promise.reject(typed);",
    '  return "rejected with six look-alikes of an SDK error";',
    "})()",
  ].join("\n"),
};

/** The text in the `fatal` and `rejection` errors that no report may carry. */
export const PRIVATE = ["Lucía", "García", "Sintel.mkv", "192.168.1.20"];

/** The request ids the `forged` rejections carry, none of which the media service made. */
export const FORGED = [
  "deadbeef-cafe-4dad-8bad-feedface2027",
  "c0ffee01-5a1e-4b0b-9a11-0000000000a1",
  "c0ffee02-5a1e-4b0b-9a11-0000000000a2",
  "c0ffee03-5a1e-4b0b-9a11-0000000000a3",
  "c0ffee04-5a1e-4b0b-9a11-0000000000a4",
  "c0ffee05-5a1e-4b0b-9a11-0000000000a5",
];

/** The words the `synthetic` rejection puts where an error's class, functions, and files would be. */
export const SYNTHETIC = ["NereaMarlow", "CloudOrchard", "PrivateLeaf.js", "fictional-lar.js"];

/** The debugger address of the app's runtime among Metro's inspector targets: the newest one. */
export const debuggerUrl = (targets) => {
  const runtimes = targets.filter((target) => typeof target.webSocketDebuggerUrl === "string");

  return runtimes.at(-1)?.webSocketDebuggerUrl;
};

/**
 * Runs `expression` in the runtime at `url` and resolves with its value. Metro takes a debugger only
 * from its own origin, so the connection names it.
 */
const evaluate = (url, expression) =>
  new Promise((resolve, reject) => {
    const origin = new URL(url).origin.replace(/^ws/u, "http");
    const socket = new WebSocket(url, { headers: { origin } });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`The app's runtime did not answer at ${url}`));
    }, 15_000);

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }),
      );
    });
    socket.addEventListener("message", (message) => {
      const reply = JSON.parse(String(message.data));

      if (reply.id !== 1) return;
      clearTimeout(timer);
      socket.close();

      if (reply.error !== undefined) reject(new Error(JSON.stringify(reply.error)));
      else resolve(reply.result?.result?.value);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`Could not reach the app's runtime at ${url}`));
    });
  });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [port, kind] = process.argv.slice(2);
  const expression = EXPRESSIONS[kind];

  if (port === undefined || expression === undefined) {
    console.error("usage: node app-force-error.mjs <metro-port> <fatal|rejection|synthetic|bundle|forged>");
    process.exit(2);
  }

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const url = debuggerUrl(targets);

  if (url === undefined) {
    console.error("Metro lists no app runtime; open the app first");
    process.exit(1);
  }

  console.log(`${kind}: ${String(await evaluate(url, expression))}`);
}
