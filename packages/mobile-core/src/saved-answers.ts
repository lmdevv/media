import type { SaveAnswers, SavedAnswersFile } from "@media/sdk/react";
import { Base64Url } from "effect/encoding";

/** A file in the app's caches folder, as expo-file-system's `File` opens one. */
export interface CacheFile {
  readonly exists: boolean;
  readonly text: () => Promise<string>;
  readonly write: (text: string) => Promise<void>;
  readonly delete: () => void;
}

/**
 * How long a saved Home may show: at most a week after the server gave it. An artwork ticket lasts
 * 7 to 14 days from the start of the week it was issued in (ADR 0011), so a saved row's images
 * still load from the server for as long as the row may show.
 */
const MAX_AGE = "7 days";

const MAX_LENGTH = 2_000_000;

/** The file's name for the server at `convexUrl`: one file per server, never shared by two. */
export const savedAnswersFileName = (convexUrl: string): string =>
  `saved-answers.${Base64Url.encode(convexUrl)}.json`;

const fileOn = (open: () => CacheFile): SavedAnswersFile => ({
  read: async () => {
    const file = open();

    return file.exists ? file.text() : null;
  },
  write: (text) => open().write(text),
  remove: async () => {
    const file = open();

    if (file.exists) file.delete();
  },
});

/**
 * What an app saves for its next launch on the server at `convexUrl` (`SaveAnswers`): the answers
 * of `queries`, in one file of its caches folder, which `cacheFile` opens by name. iOS keeps the
 * caches folder out of backups and may empty it, which reads as nothing saved. Neither app sets a
 * data-protection entitlement, so the file takes iOS's default class: readable once the phone has
 * been unlocked since it started, as when iOS wakes the app on a locked phone.
 */
export const savedAnswers = (options: {
  readonly cacheFile: (name: string) => CacheFile;
  readonly convexUrl: string;
  readonly release: string;
  readonly queries: ReadonlyArray<string>;
}): SaveAnswers => ({
  file: fileOn(() => options.cacheFile(savedAnswersFileName(options.convexUrl))),
  release: options.release,
  queries: options.queries,
  maxAge: MAX_AGE,
  maxLength: MAX_LENGTH,
});
