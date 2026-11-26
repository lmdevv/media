// Turns the stack frames an iOS app reported (`Client.error`'s `frames`) back into source files,
// lines, and functions with the source map of the bundle the app ran:
//
//   $S cli -- logs --grep Client.error --json | node symbolicate.mjs <map file or URL>
//   node symbolicate.mjs <map file or URL> <line>:<column>...
//
// A frame is `{ source, line, column }`. Only a `bundle` frame has a position in the bundle; the
// others print as they are. Which map: the batch's `bundle` field says where the JavaScript came
// from. For `embedded`, a release build, build main.jsbundle.map at the release's tag with
// `scripts/ios-release-bundle.sh <app> <dir>`. For `dev-server`, Metro serves the map of the bundle
// it served at the same address with `.map` in place of `.bundle`, while it runs that checkout.
// Hermes counts a frame's column from 1 and a source map from 0, so a column goes in one lower.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const fromApp = createRequire(new URL("../../../../apps/mobile/movies/package.json", import.meta.url));
const metro = createRequire(fromApp.resolve("metro/package.json", { paths: [fromApp.resolve("expo/package.json")] }));
const { Consumer } = metro("metro-source-map");

/** The source map at `where`, a file or an http(s) URL. */
const readMap = async (where) =>
  /^https?:\/\//u.test(where)
    ? JSON.parse(await (await fetch(where)).text())
    : JSON.parse(readFileSync(where, "utf8"));

/**
 * A resolver of bundle frames through `map`: a frame's source file, line, column (from 1), and the
 * function name the map gives there, or null where the map has nothing.
 */
export const resolver = (map) => {
  const consumer = new Consumer(map);

  return ({ line, column }) => {
    const found = consumer.originalPositionFor({ line, column: Math.max(0, column - 1) });

    return found.source === null || found.line === null
      ? null
      : { file: found.source, line: found.line, column: found.column + 1, name: found.name };
  };
};

/** One frame as a line of text, resolved through `resolve` when it is the bundle's. */
export const describeFrame = (resolve, frame) => {
  const at = `${frame.source} ${String(frame.line)}:${String(frame.column)}`;

  if (frame.source !== "bundle") return at;
  const found = resolve(frame);

  return found === null
    ? `${at} → not in the map`
    : `${at} → ${found.file}:${String(found.line)}:${String(found.column)}${found.name === null ? "" : ` (${found.name})`}`;
};

/** Each `Client.error` record in `text` (`media logs --json`) with its frames resolved. */
export const describeRecords = (resolve, text) =>
  text
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter((record) => record.message === "Client.error" && Array.isArray(record.annotations?.frames))
    .map(({ timestamp, annotations }) =>
      [
        `${timestamp} ${annotations.app} ${annotations.appVersion} (${annotations.bundle}) ${annotations.errorClass} on ${annotations.route}`,
        ...annotations.frames.map((frame) => `  ${describeFrame(resolve, frame)}`),
      ].join("\n"),
    );

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [where, ...positions] = process.argv.slice(2);

  if (where === undefined) {
    console.error("usage: node symbolicate.mjs <map file or URL> [<line>:<column>...] < records.ndjson");
    process.exit(2);
  }

  const resolve = resolver(await readMap(where));

  if (positions.length > 0) {
    for (const position of positions) {
      const [line, column] = position.split(":").map(Number);

      console.log(describeFrame(resolve, { source: "bundle", line, column }));
    }
  } else {
    console.log(describeRecords(resolve, readFileSync(0, "utf8")).join("\n\n"));
  }
}
