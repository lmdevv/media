// A TrueType font whose every printable ASCII character but space is one solid block, 0.6 em wide
// and a whole em tall (0.8 above the baseline, 0.2 below), named "Lar Blocks". Text set in it is a
// filled rectangle whose size and place follow from the script alone, so a check can tell, by the
// pixels, whether libass drew it with this font (attached to the file) or a fallback's glyphs. The
// font is generated here, as part of this repository, under its licence.
//
//   node block-font.mjs OUT.ttf   writes it
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UNITS = 1000;
const ASCENT = 800;
const DESCENT = 200;
const ADVANCE = 600;
const FIRST = 0x21;
const LAST = 0x7e;

const u16 = (value) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value & 0xffff);
  return bytes;
};

const i16 = (value) => {
  const bytes = Buffer.alloc(2);
  bytes.writeInt16BE(value);
  return bytes;
};

const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
};

const join = (...parts) => Buffer.concat(parts);

const padded = (bytes) => (bytes.length % 4 === 0 ? bytes : join(bytes, Buffer.alloc(4 - (bytes.length % 4))));

const checksum = (bytes) => {
  const whole = padded(bytes);
  let sum = 0;
  for (let at = 0; at < whole.length; at += 4) sum = (sum + whole.readUInt32BE(at)) >>> 0;
  return sum;
};

/** The font's bytes, named `family`. Glyph 0 is .notdef and 1 space, both empty; 2 is the block. */
export const blockFont = (family = "Lar Blocks") => {
  // One contour, clockwise from the bottom left, every point on the curve; coordinates as deltas.
  const block = join(
    i16(1), i16(0), i16(-DESCENT), i16(ADVANCE), i16(ASCENT),
    u16(3), u16(0), Buffer.from([1, 1, 1, 1]),
    i16(0), i16(0), i16(ADVANCE), i16(0),
    i16(-DESCENT), i16(ASCENT + DESCENT), i16(0), i16(-(ASCENT + DESCENT)),
  );
  const glyf = block;
  const loca = join(u16(0), u16(0), u16(0), u16(glyf.length / 2));
  const head = join(
    u32(0x00010000), u32(0x00010000), u32(0), u32(0x5f0f3cf5), u16(0x000b), u16(UNITS),
    u32(0), u32(0), u32(0), u32(0),
    i16(0), i16(-DESCENT), i16(ADVANCE), i16(ASCENT), u16(0), u16(8), i16(2), i16(0), i16(0),
  );
  const hhea = join(
    u32(0x00010000), i16(ASCENT), i16(-DESCENT), i16(0), u16(ADVANCE), i16(0), i16(0), i16(ADVANCE),
    i16(1), i16(0), i16(0), i16(0), i16(0), i16(0), i16(0), i16(0), u16(3),
  );
  const hmtx = join(u16(ADVANCE), i16(0), u16(ADVANCE), i16(0), u16(ADVANCE), i16(0));
  const maxp = join(
    u32(0x00010000), u16(3), u16(4), u16(1), u16(0), u16(0), u16(2),
    u16(0), u16(0), u16(0), u16(0), u16(0), u16(0), u16(0), u16(0),
  );
  // Format 4: space by delta to glyph 1, then every printable character through the glyph id array.
  const count = LAST - FIRST + 1;
  const map = join(
    u16(4), u16(16 + 3 * 8 + count * 2), u16(0), u16(6), u16(4), u16(1), u16(2),
    u16(0x20), u16(LAST), u16(0xffff), u16(0),
    u16(0x20), u16(FIRST), u16(0xffff),
    u16(1 - 0x20), u16(0), u16(1),
    u16(0), u16(4), u16(0),
    ...Array.from({ length: count }, () => u16(2)),
  );
  const cmap = join(u16(0), u16(1), u16(3), u16(1), u32(12), map);
  const names = [
    [1, family],
    [2, "Regular"],
    [3, `${family} Regular`],
    [4, `${family} Regular`],
    [5, "Version 1.0"],
    [6, `${family.replaceAll(" ", "")}-Regular`],
  ];
  const strings = names.map(([, text]) => Buffer.from(text, "utf16le").swap16());
  let offset = 0;
  const records = names.map(([id], index) => {
    const record = join(u16(3), u16(1), u16(0x409), u16(id), u16(strings[index].length), u16(offset));
    offset += strings[index].length;
    return record;
  });
  const name = join(u16(0), u16(names.length), u16(6 + 12 * names.length), ...records, ...strings);
  const os2 = join(
    u16(4), i16(ADVANCE), u16(400), u16(5), u16(0), i16(650), i16(600), i16(0), i16(75), i16(650),
    i16(600), i16(0), i16(350), i16(50), i16(250), i16(0), Buffer.alloc(10), u32(1), u32(0), u32(0),
    u32(0), Buffer.from("NONE"), u16(0x40), u16(0x20), u16(LAST), i16(ASCENT), i16(-DESCENT), i16(0),
    u16(ASCENT), u16(DESCENT), u32(1), u32(0), i16(500), i16(700), u16(0), u16(0x20), u16(0),
  );
  const post = join(u32(0x00030000), u32(0), i16(-100), i16(50), u32(0), u32(0), u32(0), u32(0), u32(0));

  const tables = { "OS/2": os2, cmap, glyf, head, hhea, hmtx, loca, maxp, name, post };
  const tags = Object.keys(tables).sort();
  let selector = 0;
  while (1 << (selector + 1) <= tags.length) selector += 1;
  const range = (1 << selector) * 16;
  let at = 12 + 16 * tags.length;
  const directory = [];
  const bodies = [];
  for (const tag of tags) {
    const table = tables[tag];
    directory.push(join(Buffer.from(tag), u32(checksum(table)), u32(at), u32(table.length)));
    bodies.push(padded(table));
    at += padded(table).length;
  }
  const font = join(
    u32(0x00010000), u16(tags.length), u16(range), u16(selector), u16(tags.length * 16 - range),
    ...directory,
    ...bodies,
  );
  const headAt = 12 + 16 * tags.length + bodies.slice(0, tags.indexOf("head")).reduce((sum, body) => sum + body.length, 0);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8);
  return font;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (out === undefined) throw new Error("usage: node block-font.mjs OUT.ttf");
  writeFileSync(out, blockFont());
}
