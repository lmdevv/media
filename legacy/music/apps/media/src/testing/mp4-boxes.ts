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
