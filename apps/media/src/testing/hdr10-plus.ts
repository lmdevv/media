/**
 * HDR10+ dynamic metadata (SMPTE ST 2094-40) added to an HEVC elementary stream, for tests that
 * need what this build's libx265 does not write (it is built without HDR10+). Every picture gets a
 * prefix SEI of ITU-T T.35 registered user data, as HDR10+ encoders write it, which ffmpeg's decoder
 * reads into each frame's side data.
 */

/** Writes bits most significant first. */
class Bits {
  readonly #bytes: Array<number> = [];
  #bit = 0;

  write(value: number, width: number): this {
    for (let shift = width - 1; shift >= 0; shift -= 1) {
      if (this.#bit === 0) this.#bytes.push(0);
      const last = this.#bytes.length - 1;

      this.#bytes[last] = (this.#bytes[last] ?? 0) | (((value >>> shift) & 1) << (7 - this.#bit));
      this.#bit = (this.#bit + 1) % 8;
    }

    return this;
  }

  get bytes(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

/**
 * One window's HDR10+ metadata for a 400 cd/m² target display: the scene's brightest components,
 * its average, nine percentiles of its maxRGB distribution, and a Bézier tone curve, so a reader
 * that applies it maps differently from one that reads only HDR10's static metadata.
 */
const hdr10PlusPayload = (): Uint8Array => {
  const bits = new Bits()
    // ITU-T T.35: United States, Samsung's provider code, HDR10+, application 4, version 1.
    .write(0xb5, 8)
    .write(0x003c, 16)
    .write(0x0001, 16)
    .write(4, 8)
    .write(1, 8)
    .write(1, 2)
    .write(400, 27)
    .write(0, 1);

  for (const maxscl of [60_000, 50_000, 40_000]) bits.write(maxscl, 17);
  bits.write(8_000, 17).write(9, 4);

  for (const [percentage, percentile] of [
    [1, 100],
    [5, 500],
    [10, 1_000],
    [25, 3_000],
    [50, 8_000],
    [75, 20_000],
    [90, 35_000],
    [95, 45_000],
    [99, 58_000],
  ] as const) {
    bits.write(percentage, 7).write(percentile, 17);
  }

  bits.write(100, 10).write(0, 1).write(1, 1).write(1_200, 12).write(2_000, 12).write(9, 4);

  for (const anchor of [180, 330, 470, 590, 700, 790, 870, 930, 980]) bits.write(anchor, 10);

  return bits.write(0, 1).bytes;
};

/** `rbsp` with emulation prevention: a 0x03 after every two zero bytes that precede 0x00 to 0x03. */
const escaped = (rbsp: Uint8Array): ReadonlyArray<number> => {
  const out: Array<number> = [];
  let zeros = 0;

  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }

    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }

  return out;
};

/** A prefix SEI NAL unit (type 39) holding one registered user data message (payload type 4). */
const seiNal = (): ReadonlyArray<number> => {
  const payload = hdr10PlusPayload();
  const sizes: Array<number> = [];
  let left = payload.length;

  for (; left >= 255; left -= 255) sizes.push(255);
  sizes.push(left);

  const rbsp = Uint8Array.from([4, ...sizes, ...payload, 0x80]);

  return [0, 0, 0, 1, 39 << 1, 1, ...escaped(rbsp)];
};

/** Where each NAL unit of an Annex B stream starts (after its start code) and its type. */
const nalUnits = (
  stream: Uint8Array,
): ReadonlyArray<{ readonly at: number; readonly type: number }> => {
  const found: Array<{ readonly at: number; readonly type: number }> = [];

  for (let at = 0; at + 3 < stream.length; at += 1) {
    if (stream[at] === 0 && stream[at + 1] === 0 && stream[at + 2] === 1) {
      found.push({ at: at + 3, type: ((stream[at + 3] ?? 0) >> 1) & 0x3f });
      at += 2;
    }
  }

  return found;
};

/**
 * `stream`, HEVC in Annex B, with the HDR10+ SEI (`seiNal`) before the first slice of every
 * picture: a slice NAL unit (types 0 to 31) whose first slice segment flag is set.
 */
export const withHdr10Plus = (stream: Uint8Array): Uint8Array => {
  const sei = seiNal();
  const out: Array<number> = [];
  let from = 0;

  for (const { at, type } of nalUnits(stream)) {
    const firstSlice = type < 32 && ((stream[at + 2] ?? 0) & 0x80) !== 0;

    if (!firstSlice) continue;
    // The start code begins at the zero bytes before `at`: three, or four with a leading zero.
    const start = at >= 4 && stream[at - 4] === 0 ? at - 4 : at - 3;

    out.push(...stream.subarray(from, start), ...sei);
    from = start;
  }

  out.push(...stream.subarray(from));

  return Uint8Array.from(out);
};
