/**
 * SHA-256 (FIPS 180-4) of a string's UTF-8 bytes, as lowercase hex, computed synchronously for
 * code that cannot await `crypto.subtle`, such as the movies document fitters. Tested against
 * `node:crypto` in `test/core/lib/sha256.test.ts`.
 */

const ROUND_CONSTANTS = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const encoder = new TextEncoder();

const rotateRight = (word: number, count: number): number =>
  (word >>> count) | (word << (32 - count));

/** The message padded to whole 64-byte blocks, ending in its length in bits, big-endian. */
const padded = (bytes: Uint8Array): DataView => {
  const blocks = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);

  blocks.set(bytes);
  blocks[bytes.length] = 0x80;

  const view = new DataView(blocks.buffer);
  const bits = bytes.length * 8;

  view.setUint32(blocks.length - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(blocks.length - 4, bits >>> 0);

  return view;
};

/** The state after compressing the 64-byte block at `offset` into `state`. */
const compress = (
  state: ReadonlyArray<number>,
  view: DataView,
  offset: number,
): ReadonlyArray<number> => {
  const schedule = new Uint32Array(64);

  for (let t = 0; t < 16; t += 1) schedule[t] = view.getUint32(offset + t * 4);

  for (let t = 16; t < 64; t += 1) {
    const early = schedule[t - 15] ?? 0;
    const late = schedule[t - 2] ?? 0;
    const sigma0 = rotateRight(early, 7) ^ rotateRight(early, 18) ^ (early >>> 3);
    const sigma1 = rotateRight(late, 17) ^ rotateRight(late, 19) ^ (late >>> 10);

    schedule[t] = (schedule[t - 16] ?? 0) + sigma0 + (schedule[t - 7] ?? 0) + sigma1;
  }

  const [a0 = 0, b0 = 0, c0 = 0, d0 = 0, e0 = 0, f0 = 0, g0 = 0, h0 = 0] = state;
  let [a, b, c, d, e, f, g, h] = [a0, b0, c0, d0, e0, f0, g0, h0];

  for (let t = 0; t < 64; t += 1) {
    const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choice = (e & f) ^ (~e & g);
    const first = (h + sum1 + choice + (ROUND_CONSTANTS[t] ?? 0) + (schedule[t] ?? 0)) >>> 0;
    const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const second = (sum0 + majority) >>> 0;

    h = g;
    g = f;
    f = e;
    e = (d + first) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (first + second) >>> 0;
  }

  return [a, b, c, d, e, f, g, h].map((word, index) => ((state[index] ?? 0) + word) >>> 0);
};

export const sha256Hex = (text: string): string => {
  const view = padded(encoder.encode(text));
  const blockOffsets = Array.from({ length: view.byteLength / 64 }, (_, block) => block * 64);

  return blockOffsets
    .reduce<ReadonlyArray<number>>((state, offset) => compress(state, view, offset), INITIAL_STATE)
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
};
