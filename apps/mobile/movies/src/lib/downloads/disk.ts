import { Data, Result } from "effect";
import type { DownloadPauseState } from "expo-file-system";

/**
 * A byte count from expo-file-system as a number. Its iOS module answers an `Int64`, which Expo
 * hands over as a BigInt although it is typed as a number, and no sum with a number survives one.
 */
export const byteCount = (value: number | bigint): number => Number(value);

/** What a file operation on the downloads folder was doing when it failed. */
export type DiskOperation =
  | "read"
  | "write"
  | "move"
  | "rename"
  | "remove"
  | "list"
  | "createFolder";

/** A file operation on the person's downloads folder failed, such as a write to a full disk. */
export class DiskFailed extends Data.TaggedError("DiskFailed")<{
  readonly operation: DiskOperation;
  /** The file or folder, relative to the person's downloads folder. */
  readonly path: string;
  readonly cause: unknown;
}> {}

/** The result of `run`, a file operation on the downloads folder, with what it threw as `DiskFailed`. */
export const onDisk = <A>(
  operation: DiskOperation,
  path: string,
  run: () => A,
): Result.Result<A, DiskFailed> => {
  try {
    return Result.succeed(run());
  } catch (cause) {
    return Result.fail(new DiskFailed({ operation, path, cause }));
  }
};

/** Reports how many bytes a transfer has written so far. */
export type TransferProgress = (progress: { readonly bytesWritten: number | bigint }) => void;

/**
 * A transfer of a video to this iPhone, as expo-file-system's `DownloadTask` runs one: started
 * once, paused with resume data, resumed, or cancelled.
 */
export interface Transfer {
  /** Resolves with the file once it lands, or null when the transfer paused first. */
  downloadAsync(): Promise<object | null>;
  /** `downloadAsync` for a transfer made from saved resume data. */
  resumeAsync(): Promise<object | null>;
  /** Pauses the transfer and waits until its resume data is ready. */
  pauseAsync(): Promise<void>;
  /** The paused transfer's state, to resume it later. */
  savable(): DownloadPauseState;
  cancel(): void;
  /** Frees the native task; the transfer is unusable after. */
  release(): void;
}

/**
 * The person's downloads folder on this iPhone (`downloads/<server>/<person>`), as the downloads
 * engine reads and writes it. Paths are relative to the folder, with `/` between names.
 */
export interface DownloadDisk {
  /** The file's text, or null when there is no file there. */
  readonly read: (path: string) => Result.Result<string | null, DiskFailed>;
  /**
   * Writes `text` over the file in place, creating the folders above it. As with a native write,
   * one cut short by a crash or a full disk leaves part of the text behind.
   */
  readonly write: (path: string, text: string) => Result.Result<void, DiskFailed>;
  /**
   * Moves a file over `to`. As expo-file-system does it, a file at `to` is deleted first, so a
   * crash between the two steps leaves neither file at `to`.
   */
  readonly move: (from: string, to: string) => Result.Result<void, DiskFailed>;
  /**
   * Renames the folder at `path`, in the person's folder, to `name` beside it in one step, which
   * needs no free space. Fails when nothing is at `path` or something already has `name`.
   */
  readonly rename: (path: string, name: string) => Result.Result<void, DiskFailed>;
  /** Deletes a file, or a folder with everything in it; nothing there is fine. */
  readonly remove: (path: string) => Result.Result<void, DiskFailed>;
  /**
   * The names in the folder at `path`, by default the person's folder, or null when it is not
   * there. A folder whose existence cannot be told fails, as one that cannot be listed does.
   */
  readonly list: (path?: string) => Result.Result<ReadonlyArray<string> | null, DiskFailed>;
  /** Creates the folder at `path` and those above it; one already there is fine. */
  readonly createFolder: (path: string) => Result.Result<void, DiskFailed>;
  /** Whether a file or folder is there. */
  readonly exists: (path: string) => boolean;
  /** The file's URI, to play or show it. */
  readonly uri: (path: string) => string;
  /**
   * Downloads a small file, a subtitle or a picture, over the file at `path`; resolves with
   * whether it landed.
   */
  readonly fetch: (url: string, path: string) => Promise<boolean>;
  /** A transfer of `url` to the file at `path`, not started yet. */
  readonly transfer: (url: string, path: string, onProgress: TransferProgress) => Transfer;
  /** A paused transfer again from its saved state; null when that state no longer resumes. */
  readonly resume: (state: DownloadPauseState, onProgress: TransferProgress) => Transfer | null;
  /** The phone's free space in bytes. */
  readonly freeBytes: () => number;
}
