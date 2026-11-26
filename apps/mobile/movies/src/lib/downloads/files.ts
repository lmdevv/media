/**
 * Where downloads live on this iPhone, under the app's documents folder, which iOS keeps:
 * `downloads/<server>/<person>/` holds the store (`index.json`) and one folder per download with
 * its video, WebVTT subtitles, picture, and its own copy of its row (`download.json`). A download
 * being removed has its folder moved to `removal+<stamp>+<id>` until the core forgets it.
 * Names come only from IDs, never from titles, so they are always safe file names.
 */

const segment = (text: string): string => text.replace(/[^\w.-]/gu, "_");

/** The folder of one person's downloads on one server, relative to the documents folder. */
export const accountFolder = (mediaUrl: string, userId: string): string =>
  `downloads/${segment(mediaUrl.replace(/^https?:\/\//u, "").replace(/\/+$/u, ""))}/${segment(userId)}`;

/** The store's file name in the person's folder. */
export const STORE_FILE = "index.json";

/**
 * The file a new copy of `path` is written to before it moves over `path`, so a crash leaves the
 * old file or the new one, never part of one.
 */
export const nextOf = (path: string): string => `${path}.new`;

/** Where a store that could not be read is kept, beside the one rebuilt in its place. */
export const UNREADABLE_STORE_FILE = "index.unreadable.json";

/** A download's own copy of its row, in its folder, from which an unreadable store is rebuilt. */
export const RECORD_FILE = "download.json";

/** The folder of one download inside its person's folder. */
export const itemFolder = (downloadId: string): string => segment(downloadId);

/** A file of one download, relative to its person's folder. */
export const itemPath = (downloadId: string, file: string): string =>
  `${itemFolder(downloadId)}/${file}`;

const REMOVAL_NAME = /^removal\+(?<stamp>\d+)\+(?<id>[^+]+)$/u;

/**
 * The name of the folder that records a removal of download `downloadId`, made at `stamp`, in
 * milliseconds since the epoch. A download's folder name never holds a `+`, so a removal's folder
 * is never taken for one, and the ID and the stamp come back from the name whole.
 */
export const removalFolder = (downloadId: string, stamp: number): string =>
  `removal+${String(stamp)}+${encodeURIComponent(downloadId)}`;

/** The download ID a removal's folder was made for, and when. */
export interface RemovalName {
  readonly id: string;
  readonly stamp: number;
}

/** The download ID and stamp the removal's folder `name` was made with; null when `name` is not one. */
export const removalNamed = (name: string): RemovalName | null => {
  const groups = REMOVAL_NAME.exec(name)?.groups;
  const encoded = groups?.["id"];
  const stamp = Number(groups?.["stamp"]);

  if (encoded === undefined || !Number.isSafeInteger(stamp)) return null;

  try {
    return { id: decodeURIComponent(encoded), stamp };
  } catch {
    return null;
  }
};

/** The video's file name, by its container, so AVPlayer reads it by its extension. */
export const videoFile = (container: "mp4" | "mov"): string => `video.${container}`;

/** A text subtitle's file name, by its track ID. */
export const subtitleFile = (trackId: string): string => `subtitle-${segment(trackId)}.vtt`;

/** The picture shown for a download offline. */
export const ARTWORK_FILE = "artwork.jpg";
