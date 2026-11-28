// A Blu-ray presentation graphics (PGS, `.sup`) subtitle stream with one picture, which ffmpeg can
// mux but not encode: a white bar with a half-transparent black frame, shown on a canvas from one
// time to another. The hardware matrix muxes it over a cropped picture to see where the canvas is
// placed.
//
//   node pgs.mjs OUT.sup   writes the default one
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const u16 = (value) => [(value >> 8) & 0xff, value & 0xff];
const u24 = (value) => [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
const u32 = (value) => [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];

/** One segment: the magic, presentation and decoding times in 90 kHz ticks, its type, its data. */
const segment = (seconds, type, data) => {
  const ticks = Math.round(seconds * 90_000);
  return [0x50, 0x47, ...u32(ticks), ...u32(0), type, ...u16(data.length), ...data];
};

/** A line of `width` pixels: runs of palette entries, run-length coded as PGS codes them. */
const line = (runs) => {
  const bytes = [];
  for (const [length, colour] of runs) {
    if (colour === 0) bytes.push(0, ...(length < 64 ? [length] : [0x40 | (length >> 8), length & 0xff]));
    else if (length < 3) for (let n = 0; n < length; n += 1) bytes.push(colour);
    else bytes.push(0, ...(length < 64 ? [0x80 | length] : [0xc0 | (length >> 8), length & 0xff]), colour);
  }
  return [...bytes, 0, 0];
};

/**
 * The stream's bytes: `object` (width and height) at `x`, `y` on a `canvas` from `from` to `to`
 * seconds, a white bar inside a frame of `border` pixels of black at half opacity.
 */
export const pgsStream = ({
  canvas = { width: 1920, height: 1080 },
  object = { width: 960, height: 120 },
  x = 480,
  y = 900,
  border = 12,
  from = 2,
  to = 22,
} = {}) => {
  const rows = [];
  for (let row = 0; row < object.height; row += 1) {
    const edge = row < border || row >= object.height - border;
    rows.push(...line(edge ? [[object.width, 2]] : [[border, 2], [object.width - 2 * border, 1], [border, 2]]));
  }
  const window = [1, 0, ...u16(x), ...u16(y), ...u16(object.width), ...u16(object.height)];
  const show = [
    ...segment(from, 0x16, [...u16(canvas.width), ...u16(canvas.height), 0x10, ...u16(0), 0x80, 0, 0, 1, ...u16(0), 0, 0, ...u16(x), ...u16(y)]),
    ...segment(from, 0x17, window),
    // Entry 1: white (Y 235, Cr and Cb 128), opaque; entry 2: black at half opacity.
    ...segment(from, 0x14, [0, 0, 1, 235, 128, 128, 255, 2, 16, 128, 128, 128]),
    ...segment(from, 0x15, [...u16(0), 0, 0xc0, ...u24(rows.length + 4), ...u16(object.width), ...u16(object.height), ...rows]),
    ...segment(from, 0x80, []),
  ];
  const clear = [
    ...segment(to, 0x16, [...u16(canvas.width), ...u16(canvas.height), 0x10, ...u16(1), 0x00, 0, 0, 0]),
    ...segment(to, 0x17, window),
    ...segment(to, 0x80, []),
  ];
  return Buffer.from([...show, ...clear]);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (out === undefined) throw new Error("usage: node pgs.mjs OUT.sup");
  writeFileSync(out, pgsStream());
}
