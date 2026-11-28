/**
 * Boxes added to an MP4 ffmpeg wrote, for tests that need what no encoder here writes: a Dolby
 * Vision configuration record (`dvcC`, `dvvC`) and an ambient viewing environment (`amve`), as an
 * iPhone's HLG carries it. ffmpeg's demuxer reads each into the stream's side data, and its decoder
 * puts an ambient viewing environment on every frame, as on a real file. The media data stays
 * where it is: ffmpeg writes the movie box after it, so no chunk offset moves.
 */

/** A box of `kind` holding `payload`. */
const box = (kind: string, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);

  view.setUint32(0, out.length);
  out.set(new TextEncoder().encode(kind), 4);
  out.set(payload, 8);

  return out;
};

/**
 * A Dolby Vision configuration record of `profile`, `level`, and base layer signal compatibility
 * `compatibility`, with an RPU and a base layer and no enhancement layer: `dvcC` for profiles up to
 * 7, `dvvC` above.
 */
export const dolbyVisionBox = (
  profile: number,
  level: number,
  compatibility: number,
): Uint8Array => {
  const record = new Uint8Array(24);

  record[0] = 1;
  record[2] = (profile << 1) | (level >> 5);
  record[3] = ((level & 31) << 3) | 0b101;
  record[4] = compatibility << 4;

  return box(profile <= 7 ? "dvcC" : "dvvC", record);
};

/** An ambient viewing environment of `lux` (in 0.0001 lux) at chromaticity `x`, `y` (in 0.00002). */
export const ambientBox = (lux: number, x: number, y: number): Uint8Array => {
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);

  view.setUint32(0, lux);
  view.setUint16(4, x);
  view.setUint16(6, y);

  return box("amve", payload);
};

/** The boxes in `bytes` from `start` to `end`: each one's offset, size, and kind. */
const boxesIn = (
  bytes: Uint8Array,
  start: number,
  end: number,
): ReadonlyArray<{ readonly at: number; readonly size: number; readonly kind: string }> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Array<{ readonly at: number; readonly size: number; readonly kind: string }> = [];

  for (let at = start; at + 8 <= end;) {
    const size = view.getUint32(at);

    found.push({ at, size, kind: new TextDecoder().decode(bytes.subarray(at + 4, at + 8)) });
    at += Math.max(size, 8);
  }

  return found;
};

/** The video sample entries a test file has. */
const VIDEO_ENTRIES: ReadonlySet<string> = new Set(["hvc1", "hev1", "dvh1", "avc1"]);

/**
 * `bytes`, an MP4 whose movie box follows its media data, with `child` added to the end of its
 * first video sample entry, the entry renamed `entry` (such as `dvh1`) when given, and every box
 * that holds it grown to match.
 */
export const withSampleEntryBox = (
  bytes: Uint8Array,
  child: Uint8Array,
  entry?: string,
): Uint8Array => {
  const top = boxesIn(bytes, 0, bytes.length);
  const movie = top.find((found) => found.kind === "moov");
  const media = top.find((found) => found.kind === "mdat");

  if (movie === undefined || media === undefined || movie.at < media.at) {
    throw new Error("The MP4 must end with its movie box");
  }

  const inside = (parent: { readonly at: number; readonly size: number }, kind: string) =>
    boxesIn(bytes, parent.at + 8, parent.at + parent.size).find((found) => found.kind === kind);

  for (const track of boxesIn(bytes, movie.at + 8, movie.at + movie.size)) {
    if (track.kind !== "trak") continue;
    const mdia = inside(track, "mdia");
    const minf = mdia === undefined ? undefined : inside(mdia, "minf");
    const stbl = minf === undefined ? undefined : inside(minf, "stbl");
    const stsd = stbl === undefined ? undefined : inside(stbl, "stsd");

    const sample =
      stsd === undefined ? undefined : boxesIn(bytes, stsd.at + 16, stsd.at + stsd.size)[0];

    if (
      mdia === undefined ||
      minf === undefined ||
      stbl === undefined ||
      stsd === undefined ||
      sample === undefined ||
      !VIDEO_ENTRIES.has(sample.kind)
    ) {
      continue;
    }

    const end = sample.at + sample.size;
    const out = new Uint8Array(bytes.length + child.length);

    out.set(bytes.subarray(0, end));
    out.set(child, end);
    out.set(bytes.subarray(end), end + child.length);

    const view = new DataView(out.buffer);

    for (const holder of [movie, track, mdia, minf, stbl, stsd, sample]) {
      view.setUint32(holder.at, holder.size + child.length);
    }

    if (entry !== undefined) out.set(new TextEncoder().encode(entry), sample.at + 4);

    return out;
  }

  throw new Error("The MP4 has no video sample entry");
};
