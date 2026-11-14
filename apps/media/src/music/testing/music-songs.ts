/**
 * What music's tests write and read on disk: songs ffmpeg makes at run time, folders, and files.
 * This Effect-free module answers with promises; `music-fixtures.ts` wraps what Effect tests need.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const FFMPEG = process.env["FFMPEG_PATH"] ?? "ffmpeg";

const FFPROBE = process.env["FFPROBE_PATH"] ?? "ffprobe";

/** Test timeout for anything that runs ffmpeg. */
export const MEDIA_TEST_TIMEOUT = 60_000;

/** A fresh folder under the system temp folder; remove it with `removeDirectory`. */
export const makeDirectory = (label: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `media-music-${label}-`));

/** Removes a file or a folder tree; a missing one is fine. */
export const removeDirectory = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

/** Sets the access and modification times of `path` to `ms` milliseconds since the epoch. */
export const setFileTime = (path: string, ms: number): Promise<void> =>
  utimes(path, ms / 1000, ms / 1000);

/** Moves a file, as a person renaming a song does. */
export const moveFile = (from: string, to: string): Promise<void> => rename(from, to);

/** Grows or cuts a file to `bytes`. */
export const resizeFile = (path: string, bytes: number): Promise<void> => truncate(path, bytes);

/** A file's size in bytes. */
export const sizeOf = async (path: string): Promise<number> => (await stat(path)).size;

/** The names in a folder, or none for a folder that is not there. */
export const namesIn = (path: string): Promise<ReadonlyArray<string>> =>
  readdir(path).catch((): ReadonlyArray<string> => []);

/** Runs ffmpeg with `args` to completion, as a test builds its files. */
export const ffmpeg = async (args: ReadonlyArray<string>): Promise<void> => {
  await run(FFMPEG, ["-hide_banner", "-nostdin", "-y", ...args]);
};

/** Runs ffprobe with `args` and answers its standard output. */
export const ffprobe = async (args: ReadonlyArray<string>): Promise<string> =>
  (await run(FFPROBE, [...args])).stdout;

/** A 1x1 PNG, which the art store accepts as an image. */
export const PNG = Uint8Array.from(
  Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
      "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
    "hex",
  ),
);

/** A song ffmpeg writes: a sine tone with `tags`. */
export interface Song {
  readonly seconds: number;
  /** Tags as ffmpeg's `-metadata` names them, such as `title` or `ITUNESADVISORY`. */
  readonly tags?: Readonly<Record<string, string>>;
  readonly frequency?: number;
  readonly sampleRate?: number;
}

/** Codec arguments by the song file's extension. */
const CODECS = new Map<string, ReadonlyArray<string>>([
  ["flac", ["-c:a", "flac"]],
  ["mp3", ["-c:a", "libmp3lame", "-b:a", "128k"]],
  ["m4a", ["-c:a", "aac", "-b:a", "128k"]],
  ["wav", ["-c:a", "pcm_s16le"]],
]);

/** Writes `song` to `path`, its format from the extension, making its folders. */
export const writeSong = async (path: string, song: Song): Promise<void> => {
  const extension = path.slice(path.lastIndexOf(".") + 1);
  const codec = CODECS.get(extension);

  if (codec === undefined) throw new Error(`No codec for .${extension}`);

  await mkdir(dirname(path), { recursive: true });

  const tone = `sine=frequency=${String(song.frequency ?? 440)}:sample_rate=${String(song.sampleRate ?? 44_100)}:duration=${String(song.seconds)}`;

  await ffmpeg([
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    tone,
    ...codec,
    ...Object.entries(song.tags ?? {}).flatMap(([name, value]) => [
      "-metadata",
      `${name}=${value}`,
    ]),
    path,
  ]);
};

/** Writes `bytes` to `path`, making its folders. */
export const writeBytes = async (path: string, bytes: Uint8Array | string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
};

/**
 * A fingerprint as the core's `fingerprint` in `music/fit.ts` keeps it, written out again here
 * so a test catches the server's own copy drifting from the core's.
 */
export const coreFingerprint = (text: string): string => {
  if (text.length <= 1024) return text;

  const lead = text.slice(0, 1024 - 65);
  const kept = /[\uD800-\uDBFF]$/u.test(lead) ? lead.slice(0, -1) : lead;

  return `${kept}#${createHash("sha256").update(text).digest("hex")}`;
};
