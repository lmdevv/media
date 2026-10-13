/** Top-level MP4 boxes of a whole file, for tests that compare stream layouts. */

/** One top-level box: its type and where it sits in the file. */
export interface TopLevelBox {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

/** The file's top-level boxes in order, up to the first malformed size. */
export const topLevelBoxes = (bytes: Uint8Array): ReadonlyArray<TopLevelBox> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Array<TopLevelBox> = [];

  for (let start = 0; start + 8 <= bytes.length;) {
    const size = view.getUint32(start);

    if (size < 8) break;
    boxes.push({
      type: String.fromCodePoint(...bytes.subarray(start + 4, start + 8)),
      start,
      end: start + size,
    });
    start += size;
  }

  return boxes;
};

/**
 * The file without its `sidx` index and `mfra` trailer: what a live transcode streams of the
 * finished file.
 */
export const withoutIndex = (bytes: Uint8Array): Buffer =>
  Buffer.concat(
    topLevelBoxes(bytes)
      .filter((box) => box.type !== "sidx" && box.type !== "mfra")
      .map((box) => bytes.subarray(box.start, box.end)),
  );

/** The decode time (`tfdt`) of every fragment of a fragmented MP4, in order. */
export const fragmentDecodeTimes = (bytes: Uint8Array): ReadonlyArray<bigint> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const times: Array<bigint> = [];

  const walk = (start: number, end: number): void => {
    for (let at = start; at + 8 <= end;) {
      const size = view.getUint32(at);
      const type = String.fromCodePoint(...bytes.subarray(at + 4, at + 8));

      if (size < 8) return;

      if (type === "moof" || type === "traf") walk(at + 8, at + size);
      else if (type === "tfdt") {
        times.push(
          bytes[at + 8] === 1 ? view.getBigUint64(at + 12) : BigInt(view.getUint32(at + 12)),
        );
      }

      at += size;
    }
  };

  walk(0, bytes.length);

  return times;
};

/** What the file's `mdat` boxes hold, without their headers: the encoded frames, in order. */
export const mediaData = (bytes: Uint8Array): Buffer =>
  Buffer.concat(
    topLevelBoxes(bytes)
      .filter((box) => box.type === "mdat")
      .map((box) => bytes.subarray(box.start + 8, box.end)),
  );
