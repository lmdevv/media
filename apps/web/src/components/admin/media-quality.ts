import type { LibraryFile } from "@media/contracts/models/catalog";

const CODEC_LABELS = new Map([
  ["h264", "H.264"],
  ["hevc", "HEVC"],
  ["av1", "AV1"],
  ["vp9", "VP9"],
  ["mpeg2video", "MPEG-2"],
  ["mpeg4", "MPEG-4"],
]);

const HDR_LABELS = {
  none: null,
  hdr10: "HDR10",
  hdr10plus: "HDR10+",
  hlg: "HLG",
  dolby_vision: "DV",
} as const;

const resolution = (height: number): string => {
  if (height >= 2000) return "2160p";

  if (height >= 1000) return "1080p";

  if (height >= 700) return "720p";

  return `${height}p`;
};

/** A file's picture as the admin file list prints it, such as `2160p · HEVC HDR10`. */
export const qualityLabel = (video: LibraryFile["video"]): string => {
  if (video === null) return "No video";

  const codec = CODEC_LABELS.get(video.codec) ?? video.codec.toUpperCase();
  const hdr = HDR_LABELS[video.hdr];

  return `${resolution(video.height)} · ${hdr === null ? codec : `${codec} ${hdr}`}`;
};

/** A media duration as `h:mm:ss`, such as `1:56:04`. */
export const formatRuntime = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");

  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
};

/** The last segment of a path, such as `Alien.1979.mkv`. */
export const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** A title with its year, such as `Alien (1979)`. */
export const titleWithYear = (title: {
  readonly name: string;
  readonly year: number | null;
}): string => (title.year === null ? title.name : `${title.name} (${title.year})`);
