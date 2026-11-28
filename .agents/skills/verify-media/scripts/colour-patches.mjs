// Colour patches whose right answer is arithmetic: a picture of known patches (a gray ramp from
// black to 1000 cd/m², saturated colours, dark and bright colours) over a moving testsrc2 band,
// written as linear light for the HDR fixtures and as 8-bit R'G'B' for the SDR ones, and the
// measure that reads a served frame's patches back and compares them with the reference's in
// CIEDE2000. The fixtures are generated here, as part of this repository, under its licence.
//
//   node colour-patches.mjs hdr UNIT OUT.raw  writes the HDR pattern (gbrpf32le, 1920x640), 1.0 = UNIT cd/m²
//   node colour-patches.mjs sdr OUT.raw       writes the SDR pattern (rgb24, 1920x640)
//   node colour-patches.mjs read FRAME.rgb    prints the patches of a 1920x1080 rgb24 frame
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The patch area: the top 640 lines of a 1920x1080 picture, 8 columns by 4 rows. */
export const PATCH_AREA = { width: 1920, height: 640, columns: 8, rows: 4 };

/** BT.709 primaries to BT.2020's, for linear light (ITU-R BT.2087). */
const BT709_TO_BT2020 = [
  [0.6274, 0.3293, 0.0433],
  [0.0691, 0.9195, 0.0114],
  [0.0164, 0.088, 0.8956],
];

const toBt2020 = (rgb) => BT709_TO_BT2020.map((row) => row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]);

/** A gray of `nits` cd/m², as linear light where 1.0 is 100 cd/m² (zscale's `npl=100`). */
const gray = (nits) => ({ name: `gray ${nits}`, kind: nits < 5 ? "dark" : nits > 150 ? "bright" : "mid", linear: [nits / 100, nits / 100, nits / 100] });

/** A BT.709 colour of linear RGB `rgb`, where 1.0 is 100 cd/m², carried in BT.2020. */
const colour709 = (name, kind, rgb) => ({ name, kind, linear: toBt2020(rgb) });

/**
 * The HDR patches, row by row: a gray ramp from black to 20 cd/m² (where tone maps crush or lift
 * black), from 40 to 1000 cd/m² (where they roll highlights off), BT.709's primaries and
 * secondaries at half of 100 cd/m², a skin tone, and BT.2020's green, which BT.709 cannot show;
 * then dark (3 cd/m²) and bright (300 cd/m²) colours.
 */
export const HDR_PATCHES = [
  ...[0, 0.1, 0.5, 1, 2.5, 5, 10, 20].map(gray),
  ...[40, 70, 100, 150, 203, 400, 700, 1000].map(gray),
  colour709("red", "saturated", [0.5, 0, 0]),
  colour709("green", "saturated", [0, 0.5, 0]),
  colour709("blue", "saturated", [0, 0, 0.5]),
  colour709("cyan", "saturated", [0, 0.5, 0.5]),
  colour709("magenta", "saturated", [0.5, 0, 0.5]),
  colour709("yellow", "saturated", [0.5, 0.5, 0]),
  colour709("skin", "mid", [0.45, 0.3, 0.22]),
  { name: "bt2020 green", kind: "saturated", linear: [0, 0.5, 0] },
  colour709("dark red", "dark", [0.03, 0, 0]),
  colour709("dark green", "dark", [0, 0.03, 0]),
  colour709("dark blue", "dark", [0, 0, 0.03]),
  colour709("dark skin", "dark", [0.03, 0.02, 0.015]),
  colour709("bright red", "bright", [3, 0, 0]),
  colour709("bright green", "bright", [0, 3, 0]),
  colour709("bright blue", "bright", [0, 0, 3]),
  colour709("bright skin", "bright", [3, 2, 1.5]),
];

/**
 * What the HDR patches should be in SDR: the reference tone map, libplacebo's BT.2390 (ITU-R BT.2390
 * EETF, constant: no peak detection, no contrast recovery, perceptual gamut mapping) to BT.709 at
 * SDR's reference white, of the generated fixtures as the image's ffmpeg 7.1 makes them, read at
 * 2 s and 20 s alike, as 8-bit BT.709 R'G'B'. BT.2390 is the ITU's own mapping of HDR to a lower
 * peak, and libplacebo the one renderer either ffmpeg build has that maps PQ, HLG, and Dolby
 * Vision, so every kind is judged against one reference that runs on no path under test: it ran
 * with nixpkgs' ffmpeg-full 9.0.2 and libplacebo 7.387 on Mesa's lavapipe, a CPU Vulkan. The
 * image's libplacebo (7.349, under ffmpeg 7.1.5) on lavapipe lies up to 4.6 (HDR10) and 5.0 (HLG)
 * from it in CIEDE2000, so the reference names its build. The feature doc says how to make it again.
 */
export const REFERENCES = {
  hdr10: [[0,0,0],[6.4,6.6,6.6],[15.4,15.7,15.6],[22.1,22.1,21.9],[34.3,34.6,34.3],[47.6,48,47.5],[65.3,65.5,65.2],[89.9,90.3,89.9],[122.4,122.7,122.3],[154.6,154.9,154.6],[174.1,174.6,174.1],[197.5,197.8,197.5],[212.9,213.2,212.8],[240.1,240.4,240.1],[252.6,253.1,252.6],[255,255,254.9],[131.7,16.4,9.7],[48.1,135.3,20.9],[1.1,3.3,130.4],[43,133.5,136.4],[127.6,19.3,133.6],[134.3,135.3,26.4],[130,108.8,94.2],[0.1,140.6,0.1],[38.8,1.1,0.4],[5.3,37.9,2.4],[0.2,1.1,38.5],[39.5,30,26.4],[238,35.8,27],[99.8,233.1,55.1],[0,27.5,228.3],[230,203.6,175.1]],
  hlg: [[0.3,0.3,0.3],[10.9,11.3,11.2],[21.1,21.1,20.7],[27.4,27.7,27.4],[40.7,41,41],[54.8,55.1,54.7],[72.6,72.8,72.6],[97.2,97.2,96.8],[129.4,129.4,129.4],[160.9,160.9,160.9],[179.9,180.3,179.9],[200.8,200.9,200.7],[215.7,215.7,215.5],[241.1,241.1,240.8],[253,253,252.5],[255,255,254.9],[130.1,38.7,27.1],[64,138.8,47.2],[35.9,24.6,115.7],[65.3,139.5,138.9],[129.4,43.7,128.7],[140.9,140.2,51.1],[132.5,117.5,104.3],[0,140,0],[42.3,13.6,9.4],[21.7,43.6,14.7],[14,9.1,37.6],[42.6,38.6,34.1],[233.8,75.9,47.1],[128.1,233.6,80.9],[65.5,44.2,211.4],[233.9,209,188.6]],
};

/** An 8-bit R'G'B' patch. */
const coded = (name, kind, rgb) => ({ name, kind, rgb });

/**
 * The SDR patches, as BT.709 R'G'B' codes in full range: a gray ramp from black to white, 75 %
 * colour bars, full primaries, a skin tone, and near-black grays, where a range or matrix fault
 * shows.
 */
export const SDR_PATCHES = [
  ...[0, 16, 32, 64, 96, 128, 160, 192].map((value) => coded(`gray ${value}`, value < 40 ? "dark" : "mid", [value, value, value])),
  coded("gray 224", "bright", [224, 224, 224]),
  coded("white", "bright", [255, 255, 255]),
  coded("75% yellow", "saturated", [191, 191, 0]),
  coded("75% cyan", "saturated", [0, 191, 191]),
  coded("75% green", "saturated", [0, 191, 0]),
  coded("75% magenta", "saturated", [191, 0, 191]),
  coded("75% red", "saturated", [191, 0, 0]),
  coded("75% blue", "saturated", [0, 0, 191]),
  coded("red", "saturated", [255, 0, 0]),
  coded("green", "saturated", [0, 255, 0]),
  coded("blue", "saturated", [0, 0, 255]),
  coded("skin", "mid", [224, 172, 140]),
  coded("orange", "saturated", [255, 128, 0]),
  coded("purple", "saturated", [128, 0, 255]),
  coded("teal", "saturated", [0, 128, 128]),
  coded("olive", "mid", [128, 128, 0]),
  coded("gray 4", "dark", [4, 4, 4]),
  coded("gray 8", "dark", [8, 8, 8]),
  coded("gray 12", "dark", [12, 12, 12]),
  coded("gray 20", "dark", [20, 20, 20]),
  coded("dark red", "dark", [40, 8, 8]),
  coded("dark green", "dark", [8, 40, 8]),
  coded("dark blue", "dark", [8, 8, 40]),
  coded("dark skin", "dark", [48, 34, 26]),
];

/** Where patch `index` lies: its cell in the patch area. */
export const patchCell = (index) => {
  const width = PATCH_AREA.width / PATCH_AREA.columns;
  const height = PATCH_AREA.height / PATCH_AREA.rows;
  return { x: (index % PATCH_AREA.columns) * width, y: Math.floor(index / PATCH_AREA.columns) * height, width, height };
};

/**
 * The HDR pattern as planar gbrpf32le (G, B, R planes), 1920x640, in linear light where 1.0 is
 * `unit` cd/m²: 100 for zscale's PQ at `npl=100`, 1000 for its HLG at `npl=1000`.
 */
export const hdrPattern = (unit) => {
  const { width, height } = PATCH_AREA;
  const planes = [new Float32Array(width * height), new Float32Array(width * height), new Float32Array(width * height)];
  HDR_PATCHES.forEach((patch, index) => {
    const cell = patchCell(index);
    const [r, g, b] = patch.linear.map((value) => (value * 100) / unit);
    for (let y = cell.y; y < cell.y + cell.height; y += 1) {
      for (let x = cell.x; x < cell.x + cell.width; x += 1) {
        planes[0][y * width + x] = g;
        planes[1][y * width + x] = b;
        planes[2][y * width + x] = r;
      }
    }
  });
  return Buffer.concat(planes.map((plane) => Buffer.from(plane.buffer)));
};

/** The SDR pattern as rgb24, 1920x640. */
export const sdrPattern = () => {
  const { width, height } = PATCH_AREA;
  const bytes = Buffer.alloc(width * height * 3);
  SDR_PATCHES.forEach((patch, index) => {
    const cell = patchCell(index);
    for (let y = cell.y; y < cell.y + cell.height; y += 1) {
      for (let x = cell.x; x < cell.x + cell.width; x += 1) {
        bytes.set(patch.rgb, (y * width + x) * 3);
      }
    }
  });
  return bytes;
};

/**
 * The mean colour of each patch in an rgb24 frame `width` wide whose top lines hold the patch area,
 * scaled from 1920 wide, over the middle half of each cell, away from chroma bleeding at its edges.
 */
export const readPatches = (rgb, width, count) => {
  const scale = width / PATCH_AREA.width;
  return Array.from({ length: count }, (_, index) => {
    const cell = patchCell(index);
    const x0 = Math.round((cell.x + cell.width / 4) * scale);
    const x1 = Math.round((cell.x + (cell.width * 3) / 4) * scale);
    const y0 = Math.round((cell.y + cell.height / 4) * scale);
    const y1 = Math.round((cell.y + (cell.height * 3) / 4) * scale);
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const at = (y * width + x) * 3;
        sum[0] += rgb[at];
        sum[1] += rgb[at + 1];
        sum[2] += rgb[at + 2];
        n += 1;
      }
    }
    return sum.map((value) => value / n);
  });
};

/** BT.709 R'G'B' (8-bit, full range) to CIELAB (D65), through BT.1886's display gamma of 2.4. */
export const labOf = (rgb) => {
  const [r, g, b] = rgb.map((value) => Math.max(0, value / 255) ** 2.4);
  const x = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const f = (t) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  const [fx, fy, fz] = [f(x / 0.95047), f(y / 1), f(z / 1.08883)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};

/** CIEDE2000 between two CIELAB colours (Sharma, Wu, and Dalal's formulation). */
export const deltaE2000 = ([l1, a1, b1], [l2, a2, b2]) => {
  const rad = Math.PI / 180;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1);
  const cp2 = Math.hypot(ap2, b2);
  const hue = (b, ap) => (b === 0 && ap === 0 ? 0 : (Math.atan2(b, ap) / rad + 360) % 360);
  const hp1 = hue(b1, ap1);
  const hp2 = hue(b2, ap2);
  const dl = l2 - l1;
  const dc = cp2 - cp1;
  let dh = 0;
  if (cp1 * cp2 !== 0) dh = Math.abs(hp2 - hp1) <= 180 ? hp2 - hp1 : hp2 - hp1 > 180 ? hp2 - hp1 - 360 : hp2 - hp1 + 360;
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh / 2) * rad);
  const lBar = (l1 + l2) / 2;
  const cpBar = (cp1 + cp2) / 2;
  let hBar = hp1 + hp2;
  if (cp1 * cp2 !== 0) hBar = Math.abs(hp1 - hp2) <= 180 ? (hp1 + hp2) / 2 : hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;
  const t = 1 - 0.17 * Math.cos((hBar - 30) * rad) + 0.24 * Math.cos(2 * hBar * rad) + 0.32 * Math.cos((3 * hBar + 6) * rad) - 0.2 * Math.cos((4 * hBar - 63) * rad);
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cpBar;
  const sh = 1 + 0.015 * cpBar * t;
  const rt = -2 * Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hBar - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh));
};

/** CIEDE2000 between two 8-bit BT.709 R'G'B' colours. */
export const deltaE = (left, right) => deltaE2000(labOf(left), labOf(right));

/** Luma of an 8-bit BT.709 R'G'B' colour, in codes. */
const lumaOf = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const fmt = (value, digits = 1) => value.toFixed(digits);

/**
 * Judges a frame's patches, `measured`, against what they should be, `expected`, both as 8-bit
 * BT.709 R'G'B': each dark gray's luma within `tolerance.dark` codes, where CIEDE2000 hardly tells a
 * crushed black from a right one; every other patch within `tolerance.deltaE` CIEDE2000 of its
 * expected colour (a dark colour too: there a few codes of a minor channel move luma far more than
 * they move the colour, 10 codes of luma for dark red being 0.9 in CIEDE2000); every gray neutral
 * (a* and b* within 3); and each pair of neighbouring grays the expected picture tells apart by 4
 * codes or more still apart by 2, so a tone map that crushes shadows or clips highlights into one
 * level fails. Returns `{ ok, evidence }` with the worst patch of each kind.
 */
export const judgePatches = (measured, expected, patches, tolerance) => {
  const faults = [];
  const worst = {};
  patches.forEach((patch, index) => {
    const got = measured[index];
    const want = expected[index];
    if (patch.kind === "dark" && patch.name.startsWith("gray")) {
      const off = Math.abs(lumaOf(got) - lumaOf(want));
      if (off > (worst.dark?.off ?? -1)) worst.dark = { off, name: patch.name };
      if (off > tolerance.dark) faults.push(`${patch.name} luma ${fmt(lumaOf(got), 0)} where ${fmt(lumaOf(want), 0)} is right`);
    } else {
      const off = deltaE(got, want);
      const kind = patch.kind === "dark" ? "dark colour" : patch.kind;
      if (off > (worst[kind]?.off ?? -1)) worst[kind] = { off, name: patch.name };
      if (off > tolerance.deltaE) faults.push(`${patch.name} ΔE ${fmt(off)} (${got.map((v) => fmt(v, 0)).join("/")} for ${want.map((v) => fmt(v, 0)).join("/")})`);
    }
    if (patch.name.startsWith("gray")) {
      const [, a, b] = labOf(got);
      if (Math.max(Math.abs(a), Math.abs(b)) > 3) faults.push(`${patch.name} tinted (a* ${fmt(a)}, b* ${fmt(b)})`);
    }
  });
  const grays = patches
    .map((patch, index) => ({ patch, got: lumaOf(measured[index]), want: lumaOf(expected[index]) }))
    .filter(({ patch }) => patch.name.startsWith("gray"))
    .toSorted((left, right) => left.want - right.want);
  for (const [index, gray] of grays.entries()) {
    const next = grays[index + 1];
    if (next !== undefined && next.want - gray.want >= 4 && next.got - gray.got < 2) {
      faults.push(`${gray.patch.name} and ${next.patch.name} merge (luma ${fmt(gray.got, 0)} and ${fmt(next.got, 0)}, ${fmt(gray.want, 0)} and ${fmt(next.want, 0)} right)`);
    }
  }
  const summary = Object.entries(worst)
    .map(([kind, { off, name }]) => `${kind} ${kind === "dark" ? `luma ±${fmt(off, 0)}` : `ΔE ${fmt(off)}`} (${name})`)
    .join(", ");
  return faults.length === 0 ? { ok: true, evidence: `worst: ${summary}` } : { ok: false, evidence: `${faults.slice(0, 3).join("; ")}${faults.length > 3 ? ` and ${faults.length - 3} more` : ""}; worst: ${summary}` };
};

/**
 * The mean 10-bit Y', Cb, and Cr codes of each patch in a yuv420p10le frame `width` by `height`
 * whose top lines hold the patch area, scaled from 1920 wide, over the middle half of each cell, as
 * `readPatches` reads R'G'B': what an HDR stream's patches are before any conversion.
 */
export const readYuvPatches = (yuv, width, height, count) => {
  const samples = new Uint16Array(yuv.buffer, yuv.byteOffset, Math.floor(yuv.byteLength / 2));
  const chroma = width * height;
  const quarter = chroma / 4;
  const scale = width / PATCH_AREA.width;
  const mean = (plane, stride, x0, x1, y0, y1) => {
    let sum = 0;
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) sum += samples[plane + y * stride + x];
    return sum / ((x1 - x0) * (y1 - y0));
  };
  return Array.from({ length: count }, (_, index) => {
    const cell = patchCell(index);
    const x0 = Math.round((cell.x + cell.width / 4) * scale);
    const x1 = Math.round((cell.x + (cell.width * 3) / 4) * scale);
    const y0 = Math.round((cell.y + cell.height / 4) * scale);
    const y1 = Math.round((cell.y + (cell.height * 3) / 4) * scale);
    const half = (value) => Math.floor(value / 2);
    return [
      mean(0, width, x0, x1, y0, y1),
      mean(chroma, width / 2, half(x0), half(x1), half(y0), half(y1)),
      mean(chroma + quarter, width / 2, half(x0), half(x1), half(y0), half(y1)),
    ];
  });
};

/** SMPTE ST 2084's constants. */
const PQ = { m1: 2610 / 16384, m2: (2523 / 4096) * 128, c1: 3424 / 4096, c2: (2413 / 4096) * 32, c3: (2392 / 4096) * 32 };

/** PQ's EOTF: a signal in 0..1 to cd/m². */
const pqToNits = (signal) => {
  const power = Math.max(signal, 0) ** (1 / PQ.m2);
  return 10000 * (Math.max(power - PQ.c1, 0) / (PQ.c2 - PQ.c3 * power)) ** (1 / PQ.m1);
};

/** PQ's inverse EOTF: cd/m² to a signal in 0..1. */
const nitsToPq = (nits) => {
  const power = (Math.max(nits, 0) / 10000) ** PQ.m1;
  return ((PQ.c1 + PQ.c2 * power) / (1 + PQ.c3 * power)) ** PQ.m2;
};

/** HLG's inverse OETF (ITU-R BT.2100): a signal in 0..1 to scene light in 0..1. */
const hlgToScene = (signal) => {
  const a = 0.17883277;
  const b = 1 - 4 * a;
  const c = 0.5 - a * Math.log(4 * a);
  return signal <= 0.5 ? (signal * signal) / 3 : (Math.exp((signal - c) / a) + b) / 12;
};

/**
 * Display light in cd/m² of a 10-bit limited-range BT.2020 Y'CbCr colour in `transfer`: PQ's own,
 * or HLG's on its nominal 1000 cd/m² display (BT.2100's OOTF, system gamma 1.2).
 */
const displayLight = ([y, cb, cr], transfer) => {
  const luma = (y - 64) / 876;
  const blue = (cb - 512) / 896;
  const red = (cr - 512) / 896;
  const r = luma + 1.4746 * red;
  const b = luma + 1.8814 * blue;
  const g = (luma - 0.2627 * r - 0.0593 * b) / 0.678;
  if (transfer === "pq") return [r, g, b].map(pqToNits);
  const scene = [r, g, b].map((value) => hlgToScene(Math.min(Math.max(value, 0), 1)));
  const sceneLuma = 0.2627 * scene[0] + 0.678 * scene[1] + 0.0593 * scene[2];
  return scene.map((value) => 1000 * sceneLuma ** 0.2 * value);
};

/** ICtCp (ITU-R BT.2100) of display light in cd/m², BT.2020 primaries. */
const ictcpOf = ([r, g, b]) => {
  const l = nitsToPq((1688 * r + 2146 * g + 262 * b) / 4096);
  const m = nitsToPq((683 * r + 2951 * g + 462 * b) / 4096);
  const s = nitsToPq((99 * r + 309 * g + 3688 * b) / 4096);
  return [0.5 * l + 0.5 * m, (6610 * l - 13613 * m + 7003 * s) / 4096, (17933 * l - 17390 * m - 543 * s) / 4096];
};

/**
 * ΔE ITP (ITU-R BT.2124) between two 10-bit BT.2020 Y'CbCr colours in `transfer` (`pq` or `hlg`):
 * 1 is about the smallest difference a viewer sees, in the dark, bright, and saturated alike.
 */
export const deltaItp = (left, right, transfer) => {
  const [i1, ct1, cp1] = ictcpOf(displayLight(left, transfer));
  const [i2, ct2, cp2] = ictcpOf(displayLight(right, transfer));
  return 720 * Math.sqrt((i1 - i2) ** 2 + (0.5 * (ct1 - ct2)) ** 2 + (cp1 - cp2) ** 2);
};

/**
 * Judges an HDR stream's patches, `measured`, against the source's own, `expected`, both as 10-bit
 * Y'CbCr in `transfer`: every patch within `tolerance.deltaItp` ΔE ITP of the source's, as the
 * picture was scaled and re-encoded, not mapped. Returns `{ ok, evidence }` with the worst patch of
 * each kind.
 */
export const judgeHdrPatches = (measured, expected, patches, transfer, tolerance) => {
  const faults = [];
  const worst = {};
  patches.forEach((patch, index) => {
    const off = deltaItp(measured[index], expected[index], transfer);
    if (off > (worst[patch.kind]?.off ?? -1)) worst[patch.kind] = { off, name: patch.name };
    if (off > tolerance.deltaItp) {
      faults.push(`${patch.name} ΔE ITP ${fmt(off)} (${measured[index].map((v) => fmt(v, 0)).join("/")} for ${expected[index].map((v) => fmt(v, 0)).join("/")})`);
    }
  });
  const summary = Object.entries(worst)
    .map(([kind, { off, name }]) => `${kind} ΔE ITP ${fmt(off)} (${name})`)
    .join(", ");
  return faults.length === 0 ? { ok: true, evidence: `worst: ${summary}` } : { ok: false, evidence: `${faults.slice(0, 3).join("; ")}${faults.length > 3 ? ` and ${faults.length - 3} more` : ""}; worst: ${summary}` };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  const file = rest.at(-1);
  if (mode === "hdr") writeFileSync(file, hdrPattern(Number(rest[0])));
  else if (mode === "sdr") writeFileSync(file, sdrPattern());
  else if (mode === "read") {
    const patches = readPatches(readFileSync(file), 1920, 32);
    console.log(patches.map((rgb, index) => `${index} ${rgb.map((value) => value.toFixed(1)).join(" ")}`).join("\n"));
  } else {
    console.error("usage: node colour-patches.mjs hdr UNIT OUT.raw | sdr OUT.raw | read FRAME.rgb");
    process.exit(2);
  }
}
