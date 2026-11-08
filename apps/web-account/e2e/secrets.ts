import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

/**
 * What a run must never keep: the core's secrets (invites `mi_`, reset links `mr_`, devices `dv_`,
 * device codes `dc_`, API keys `mk_`, guest links `mg_`, group-session links `mt_`, each an id then
 * a secret), any JWT, any Convex Auth refresh token (two ids joined by `|`), and the passwords the
 * tests make (`newSecret`). Nothing bounds a match's start, so `%23mi_…` matches too.
 */
const SECRETS = [
  /(?:mi|mr|dv|dc|mk|mg|mt)_[a-z0-9]{8,}\.[\w-]{16,}/u,
  /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/u,
  /[a-z0-9]{32}(?:\||%7C)[a-z0-9]{32}/iu,
  /e2e-secret-[a-z0-9]{6,}/u,
];

const ZIP_END = 0x06_05_4b_50;

const ZIP_ENTRY = 0x02_01_4b_50;

const DEFLATE = 8;

const ZIP_START = 0x04_03_4b_50;

/**
 * The uncompressed bytes of each entry of a zip archive, such as a Playwright trace. Throws on an
 * archive it cannot read.
 */
const zipEntries = (zip: Buffer): ReadonlyArray<Buffer> => {
  if (zip.length < 4 || zip.readUInt32LE(0) !== ZIP_START) return [];
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));

  if (end < 0 || zip.readUInt32LE(end) !== ZIP_END) throw new Error("No zip directory");

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
  SECRETS.some((secret) => secret.test(bytes.toString("latin1"))) ||
  zipEntries(bytes).some(holdsSecret);

/** Whether `bytes` hold a secret, counting a file it cannot read through as one that does. */
const mayHoldSecret = (bytes: Buffer): boolean => {
  try {
    return holdsSecret(bytes);
  } catch {
    return true;
  }
};

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
    files.map(async (file) => (mayHoldSecret(await readFile(file)) ? [file] : [])),
  );

  return found.flat();
};

/** Deletes `files`, so a failed run's uploaded results never carry them. */
export const removeAll = (files: ReadonlyArray<string>): Promise<ReadonlyArray<void>> =>
  Promise.all(files.map((file) => rm(file, { force: true })));
