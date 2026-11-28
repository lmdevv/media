// Checks which faces libass draws an ASS style in when the style names a family the install lacks,
// as most styled subtitles do (Arial, Helvetica, a font the file never attached). The image's
// smoke test and the NixOS module's sandbox check draw this script with the service's ffmpeg and
// fonts, then judge the frames and the log here.
//
//   node scripts/font-fallback.ts script               prints the script to draw
//   node scripts/font-fallback.ts judge FRAMES LOG     judges the drawing: FRAMES is gray, 640x360,
//                                                     a frame a second over black; LOG is ffmpeg's
//                                                     output at `-v info`
import { readFileSync } from "node:fs";

const WIDTH = 640;

const HEIGHT = 360;

interface Line {
  readonly family: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /** The face libass must draw it in, by its PostScript name. */
  readonly face: string;
}

/**
 * A second each: DejaVu Sans, which both installs have, then Arial, which neither has, upright,
 * bold, and italic. Each Arial line must draw in DejaVu Sans's face at its size.
 */
const LINES: ReadonlyArray<Line> = [
  { family: "DejaVu Sans", bold: false, italic: false, face: "DejaVuSans" },
  { family: "Arial", bold: false, italic: false, face: "DejaVuSans" },
  { family: "DejaVu Sans", bold: true, italic: false, face: "DejaVuSans-Bold" },
  { family: "Arial", bold: true, italic: false, face: "DejaVuSans-Bold" },
  { family: "DejaVu Sans", bold: false, italic: true, face: "DejaVuSans-Oblique" },
  { family: "Arial", bold: false, italic: true, face: "DejaVuSans-Oblique" },
];

const nameOf = (line: Line): string =>
  `${line.family}${line.bold ? " bold" : ""}${line.italic ? " italic" : ""}`;

/** An ASS time `second` seconds in. */
const at = (second: number) => `0:00:0${String(second)}.00`;

/** An ASS style's flag. */
const flag = (on: boolean) => (on ? "-1" : "0");

/** White text at 40 with no border or shadow, centred, so its samples are the glyphs alone. */
const script = (): string =>
  [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${String(WIDTH)}`,
    `PlayResY: ${String(HEIGHT)}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...LINES.map(
      (line, index) =>
        `Style: S${String(index)},${line.family},40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,${flag(line.bold)},${flag(line.italic)},0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    ),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...LINES.map(
      (_, index) =>
        `Dialogue: 0,${at(index)},${at(index + 1)},S${String(index)},,0,0,0,,Lar draws text`,
    ),
    "",
  ].join("\n");

interface Box {
  readonly width: number;
  readonly height: number;
}

/** The size of the box of samples over 128 in frame `index` of `gray`, or none. */
const boxIn = (gray: Uint8Array, index: number): Box | undefined => {
  const size = WIDTH * HEIGHT;
  let left = WIDTH;
  let top = HEIGHT;
  let right = -1;
  let bottom = -1;

  for (let sample = 0; sample < size; sample += 1) {
    if ((gray[index * size + sample] ?? 0) > 128) {
      const x = sample % WIDTH;
      const y = Math.floor(sample / WIDTH);

      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  return right < 0 ? undefined : { width: right - left + 1, height: bottom - top + 1 };
};

/** The faces libass chose, by family, weight, and slant, from its `fontselect` lines. */
const facesIn = (log: string): ReadonlyMap<string, string> =>
  new Map(
    Array.from(
      log.matchAll(/fontselect: \((.+?), (\d+), (\d+)\) -> .*, \d+, (\S+)$/gmu),
      (match) => [`${match[1] ?? ""} ${match[2] ?? ""} ${match[3] ?? ""}`, match[4] ?? ""],
    ),
  );

/** What is wrong with a drawing of `script()`: its frames as gray samples, and its log. */
const judge = (gray: Uint8Array, log: string): ReadonlyArray<string> => {
  const faces = facesIn(log);
  const boxes = LINES.map((_, index) => boxIn(gray, index));

  const problems: Array<string> = [];

  for (const [index, line] of LINES.entries()) {
    const name = nameOf(line);

    const box = boxes[index];

    const face = faces.get(
      `${line.family} ${line.bold ? "700" : "400"} ${line.italic ? "100" : "0"}`,
    );

    const known = index % 2 === 1 ? boxes[index - 1] : undefined;

    if (face !== line.face) problems.push(`${name} took ${face ?? "no face"}, not ${line.face}`);

    if (box === undefined) problems.push(`${name} drew nothing`);
    else if (
      known !== undefined &&
      (Math.abs(box.width - known.width) > 1 || Math.abs(box.height - known.height) > 1)
    ) {
      problems.push(
        `${name} drew ${String(box.width)}x${String(box.height)}, where DejaVu Sans drew ${String(known.width)}x${String(known.height)}`,
      );
    }
  }

  return problems;
};

const [mode, frames, log] = process.argv.slice(2);

if (mode === "script") {
  process.stdout.write(script());
} else if (mode === "judge" && frames !== undefined && log !== undefined) {
  const problems = judge(readFileSync(frames), readFileSync(log, "utf8"));

  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  }
} else {
  console.error("usage: font-fallback.ts script | judge FRAMES LOG");
  process.exitCode = 2;
}
