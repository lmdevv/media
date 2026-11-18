/**
 * Where downloads live on this iPhone, under the app's documents folder, which iOS keeps:
 * `downloads/<server>/<person>/` holds the store (`index.json`) and one folder per download with
 * its video, WebVTT subtitles, and picture.
 * Names come only from IDs, never from titles, so they are always safe file names.
 */

const segment = (text: string): string => text.replace(/[^\w.-]/gu, "_");

/** The folder of one person's downloads on one server, relative to the documents folder. */
export const accountFolder = (mediaUrl: string, userId: string): string =>
  `downloads/${segment(mediaUrl.replace(/^https?:\/\//u, "").replace(/\/+$/u, ""))}/${segment(userId)}`;

/** The store's file name in the person's folder. */
export const STORE_FILE = "index.json";

/** The folder of one download inside its person's folder. */
export const itemFolder = (downloadId: string): string => segment(downloadId);

/** The video's file name, by its container, so AVPlayer reads it by its extension. */
export const videoFile = (container: "mp4" | "mov"): string => `video.${container}`;

/** A text subtitle's file name, by its track ID. */
export const subtitleFile = (trackId: string): string => `subtitle-${segment(trackId)}.vtt`;

/** The picture shown for a download offline. */
export const ARTWORK_FILE = "artwork.jpg";
