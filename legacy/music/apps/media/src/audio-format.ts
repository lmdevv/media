/**
 * Audio file kinds the library accepts, how browsers name them, and which ones browsers can play
 * without a transcode.
 */

const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  "flac",
  "mp3",
  "m4a",
  "aac",
  "alac",
  "ogg",
  "oga",
  "opus",
  "wav",
  "aif",
  "aiff",
  "wma",
]);

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ["flac", "audio/flac"],
  ["mp3", "audio/mpeg"],
  ["m4a", "audio/mp4"],
  ["alac", "audio/mp4"],
  ["aac", "audio/aac"],
  ["ogg", "audio/ogg"],
  ["oga", "audio/ogg"],
  ["opus", "audio/ogg"],
  ["wav", "audio/wav"],
  ["aif", "audio/aiff"],
  ["aiff", "audio/aiff"],
  ["wma", "audio/x-ms-wma"],
]);

/** Codecs that current Chrome, Firefox, and Safari all decode natively. */
const BROWSER_CODECS: ReadonlySet<string> = new Set([
  "mp3",
  "aac",
  "flac",
  "opus",
  "vorbis",
  "pcm",
]);

/** Lowercased extension of a file name without the dot, or an empty string. */
export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");

  return dot === -1 || dot < name.lastIndexOf("/") ? "" : name.slice(dot + 1).toLowerCase();
};

/** True when a file name has one of the library's audio extensions. */
export const isAudioFile = (name: string): boolean => AUDIO_EXTENSIONS.has(extensionOf(name));

/** The `Content-Type` for an audio file, chosen by extension. */
export const contentTypeFor = (path: string): string =>
  CONTENT_TYPES.get(extensionOf(path)) ?? "application/octet-stream";

/**
 * Short lowercase codec name from the decoder's description, such as `flac`, `mp3`, `aac`,
 * `alac`, `opus`, `vorbis`, `pcm`, or `wma`. Unknown descriptions fall back to the extension.
 */
export const normalizeCodec = (description: string | undefined, path: string): string => {
  const text = (description ?? "").toLowerCase();

  if (text.includes("flac")) return "flac";

  if (text.includes("layer 3") || text === "mp3") return "mp3";

  if (text.includes("alac")) return "alac";

  if (text.includes("aac") || text.includes("mp4a")) return "aac";

  if (text.includes("opus")) return "opus";

  if (text.includes("vorbis")) return "vorbis";

  if (text.includes("pcm")) return "pcm";

  if (text.includes("wma") || text.includes("windows media")) return "wma";
  const extension = extensionOf(path);

  return extension === "" ? "unknown" : extension;
};

/** True when browsers can play the stored file directly, given its codec and extension. */
export const isBrowserPlayable = (codec: string, path: string): boolean => {
  const extension = extensionOf(path);

  if (extension === "aif" || extension === "aiff" || extension === "wma") return false;

  return BROWSER_CODECS.has(codec);
};
