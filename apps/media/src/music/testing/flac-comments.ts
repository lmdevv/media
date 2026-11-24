/**
 * Writes a FLAC file's Vorbis comments as a tagger does, which ffmpeg cannot: one comment per
 * value, so a field repeats once per artist (`ARTIST=Mora`, `ARTIST=JHAYCO`).
 */
import { readFile, writeFile } from "node:fs/promises";

/** The FLAC metadata block types this rewrite drops or writes. */
const PADDING = 1;

const VORBIS_COMMENT = 4;

/** A FLAC metadata block: its type and its body. */
interface Block {
  readonly type: number;
  readonly body: Buffer;
}

const uint32le = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);

  bytes.writeUInt32LE(value);

  return bytes;
};

/** The metadata blocks after the `fLaC` marker, and where the audio frames start. */
const blocksOf = (
  bytes: Buffer,
  at = 4,
  found: ReadonlyArray<Block> = [],
): { readonly blocks: ReadonlyArray<Block>; readonly audio: number } => {
  const header = bytes.readUInt8(at);
  const length = bytes.readUIntBE(at + 1, 3);
  const blocks = [...found, { type: header % 128, body: bytes.subarray(at + 4, at + 4 + length) }];

  return header >= 128
    ? { blocks, audio: at + 4 + length }
    : blocksOf(bytes, at + 4 + length, blocks);
};

const vorbisComment = (comments: ReadonlyArray<readonly [string, string]>): Buffer => {
  const vendor = Buffer.from("media music tests");
  const entries = comments.map(([name, value]) => Buffer.from(`${name}=${value}`, "utf8"));

  return Buffer.concat([
    uint32le(vendor.length),
    vendor,
    uint32le(entries.length),
    ...entries.flatMap((entry) => [uint32le(entry.length), entry]),
  ]);
};

/**
 * Replaces the Vorbis comments of the FLAC file at `path` with `comments`, each a field and its
 * value, in order, keeping its stream info and audio.
 *
 * @throws Error when the file is not FLAC.
 */
export const setFlacComments = async (
  path: string,
  comments: ReadonlyArray<readonly [string, string]>,
): Promise<void> => {
  const bytes = await readFile(path);

  if (bytes.toString("latin1", 0, 4) !== "fLaC") throw new Error(`${path} is not FLAC`);

  const { blocks, audio } = blocksOf(bytes);

  const kept: ReadonlyArray<Block> = [
    ...blocks.filter((block) => block.type !== VORBIS_COMMENT && block.type !== PADDING),
    { type: VORBIS_COMMENT, body: vorbisComment(comments) },
  ];

  const written = kept.flatMap((block, index) => {
    const header = Buffer.alloc(4);

    header.writeUInt8((index === kept.length - 1 ? 128 : 0) + block.type);
    header.writeUIntBE(block.body.length, 1, 3);

    return [header, block.body];
  });

  await writeFile(path, Buffer.concat([bytes.subarray(0, 4), ...written, bytes.subarray(audio)]));
};
