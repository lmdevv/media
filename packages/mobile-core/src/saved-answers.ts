import type { SaveAnswers, SavedAnswersFile } from "@media/sdk/react";
import { Base64Url } from "effect/encoding";

import type { Keychain } from "./keychain";
import { readAppRecord, readPhoneAccount } from "./records";

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

/** This app's keychains, and the media server they hold its sign-in for. */
interface Here {
  readonly own: Keychain;
  readonly shared: Keychain;
  readonly server: string;
}

/**
 * Whether the phone's shared record names another person on `server` than this app last signed
 * in as there. Another person's password sign-in in a sibling app took the phone, which revoked
 * the earlier person's grant and ended every session it minted, this app's included (D64).
 */
const takenBySomeoneElse = ({ own, shared, server }: Here): boolean => {
  const phone = readPhoneAccount(shared);
  const { person } = readAppRecord(own, server);

  return (
    phone !== null && person !== null && phone.server === server && phone.userId !== person.userId
  );
};

/**
 * What an app saves for its next launch on the server at `convexUrl` (`SaveAnswers`): the answers
 * of `queries`, in one file of its caches folder, which `cacheFile` opens by name. iOS keeps the
 * caches folder out of backups and may empty it, which reads as nothing saved. Neither app sets a
 * data-protection entitlement, so the file takes iOS's default class: readable once the phone has
 * been unlocked since it started, as when iOS wakes the app on a locked phone.
 *
 * Undefined, with the file deleted, when another person has taken the phone in a sibling app
 * since this app last signed in (`here`): this app still holds the earlier person's session, which
 * the core ended, so their saved answers must not show before it says so.
 */
export const savedAnswers = (options: {
  readonly cacheFile: (name: string) => CacheFile;
  readonly convexUrl: string;
  readonly release: string;
  readonly queries: ReadonlyArray<string>;
  readonly here: Here;
}): SaveAnswers | undefined => {
  const file = fileOn(() => options.cacheFile(savedAnswersFileName(options.convexUrl)));

  if (takenBySomeoneElse(options.here)) {
    void file.remove().catch(() => undefined);

    return undefined;
  }

  return {
    file,
    release: options.release,
    queries: options.queries,
    maxAge: MAX_AGE,
    maxLength: MAX_LENGTH,
  };
};
