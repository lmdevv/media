/** Reads ADTS (`audio/aac`) streams, for tests that compare them with the MP4 they mirror. */

/**
 * The encoded frames of an ADTS stream without their headers, concatenated in order, or null
 * when a frame does not start with the ADTS sync word or is cut short.
 */
export const adtsPayload = (bytes: Uint8Array): Buffer | null => {
  const frames: Array<Uint8Array> = [];

  for (let start = 0; start < bytes.length;) {
    const [first = 0, second = 0, , fourth = 0, fifth = 0, sixth = 0] = bytes.subarray(
      start,
      start + 7,
    );

    // Twelve set bits start every frame header.
    if (start + 7 > bytes.length || first !== 0xff || (second & 0xf0) !== 0xf0) return null;

    // Without CRC protection the header is 7 bytes, with it 9.
    const headerLength = (second & 1) === 1 ? 7 : 9;
    const frameLength = ((fourth & 0b11) << 11) | (fifth << 3) | (sixth >> 5);

    if (frameLength < headerLength || start + frameLength > bytes.length) return null;
    frames.push(bytes.subarray(start + headerLength, start + frameLength));
    start += frameLength;
  }

  return Buffer.concat(frames);
};
