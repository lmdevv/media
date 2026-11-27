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
import { fileURLToPath } from "node:url";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The numbers one segment of a source map's `mappings` holds, decoded from base64 VLQ. */
const decodeSegment = (text) => {
  const values = [];
  let value = 0;
  let shift = 0;

  for (const char of text) {
    const digit = BASE64.indexOf(char);

    if (digit < 0) throw new Error(`Not a source map segment: ${text}`);
    value += (digit & 31) << shift;

    if ((digit & 32) === 0) {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    } else {
      shift += 5;
    }
  }

  return values;
};

/**
 * Each generated line of a version 3 source map, as its segments in column order: the generated
 * column (from 0), and the source file, line (from 1), column (from 0), and name where the
 * segment has them.
 */
const linesOf = (map) => {
  let source = 0;
  let line = 0;
  let column = 0;
  let name = 0;

  return map.mappings.split(";").map((text) => {
    let generated = 0;

    return text
      .split(",")
      .filter((segment) => segment.length > 0)
      .map((segment) => {
        const values = decodeSegment(segment);

        generated += values[0];

        if (values.length < 4) return { generated, file: null };
        source += values[1];
        line += values[2];
        column += values[3];

        if (values.length > 4) name += values[4];

        return {
          generated,
          file: map.sources[source],
          line: line + 1,
          column,
          name: values.length > 4 ? map.names[name] : null,
        };
      })
      .sort((a, b) => a.generated - b.generated);
  });
};

/**
 * The source position `map` gives for generated `line` (from 1) and `column` (from 0): that of
 * the last segment at or before the column, as Metro's own consumer answers; null where none is,
 * or the segment names no source. A map in sections answers from the section that holds the
 * position.
 */
const positionIn = (map) => {
  if (Array.isArray(map.sections)) {
    const sections = map.sections.map((section) => ({ ...section.offset, find: positionIn(section.map) }));

    return (line, column) => {
      const section = sections.findLast(
        (each) => each.line + 1 < line || (each.line + 1 === line && each.column <= column),
      );

      if (section === undefined) return null;

      return section.find(line - section.line, section.line + 1 === line ? column - section.column : column);
    };
  }

  const lines = linesOf(map);

  return (line, column) => {
    const found = (lines[line - 1] ?? []).findLast((segment) => segment.generated <= column);

    return found === undefined || found.file === null ? null : found;
  };
};

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
  const find = positionIn(map);

  return ({ line, column }) => {
    const found = find(line, Math.max(0, column - 1));

    return found === null ? null : { file: found.file, line: found.line, column: found.column + 1, name: found.name };
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
