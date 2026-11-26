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
// top frame is a position in the bundle for its source map to turn back into source.

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
};

/** The text in the `fatal` and `rejection` errors that no report may carry. */
export const PRIVATE = ["Lucía", "García", "Sintel.mkv", "192.168.1.20"];

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
    console.error("usage: node app-force-error.mjs <metro-port> <fatal|rejection|synthetic|bundle>");
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
