import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

/**
 * The core's one-time secrets: invite (`mi_`), reset (`mr_`), device (`dv_`), and group-session
 * (`mt_`) codes, an id then a secret of at least 16 URL-safe characters.
 */
const SECRET = /\b(?:mi|mr|dv|mt)_[a-z0-9]{8,}\.[\w-]{16,}/u;

const ZIP_END = 0x06_05_4b_50;

const ZIP_ENTRY = 0x02_01_4b_50;

const DEFLATE = 8;

/** The uncompressed bytes of each entry of a zip archive, such as a Playwright trace. */
const zipEntries = (zip: Buffer): ReadonlyArray<Buffer> => {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));

  if (end < 0 || zip.readUInt32LE(end) !== ZIP_END) return [];

  const count = zip.readUInt16LE(end + 10);
  const entries: Array<Buffer> = [];
  let at = zip.readUInt32LE(end + 16);

  for (let index = 0; index < count && zip.readUInt32LE(at) === ZIP_ENTRY; index += 1) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const stored = zip.subarray(data, data + size);

    entries.push(method === DEFLATE ? inflateRawSync(stored) : stored);
    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
};

const holdsSecret = (bytes: Buffer): boolean =>
  SECRET.test(bytes.toString("latin1")) || zipEntries(bytes).some(holdsSecret);

const filesUnder = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true }).catch(
    () => [],
  );

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
};

/** The files under `directory` that hold one of the core's secrets, traces included. */
export const filesHoldingSecrets = async (directory: string): Promise<ReadonlyArray<string>> => {
  const files = await filesUnder(directory);

  const found = await Promise.all(
    files.map(async (file) => (holdsSecret(await readFile(file)) ? [file] : [])),
  );

  return found.flat();
};

/** Deletes `files`, so a failed run's uploaded results never carry them. */
export const removeAll = (files: ReadonlyArray<string>): Promise<ReadonlyArray<void>> =>
  Promise.all(files.map((file) => rm(file, { force: true })));
